require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT       || 3001;
const REDIS_URL   = process.env.REDIS_URL  || 'redis://localhost:6379';
const CLIENT_URL  = process.env.CLIENT_URL || '*';

// Redis key constants
const WAITING_QUEUE = 'waitingQueue';
const ACTIVE_PAIRS  = 'activePairs';
const BANNED_IPS    = 'bannedIPs';
const MSG_MAX_LEN   = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────
const ts  = () => new Date().toISOString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

/** Generate a random 6-character uppercase alphanumeric code (e.g. "XK4821") */
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Redis ─────────────────────────────────────────────────────────────────────
// When REDIS_URL uses rediss:// (TLS — required by Upstash) ioredis needs the
// tls option explicitly; otherwise it connects in plaintext and Upstash rejects it.
const redis = new Redis(REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  ...(REDIS_URL.startsWith('rediss://') && { tls: {} }),
});

redis.on('connect', () => log('🔴 Redis connected'));
redis.on('error', (err) => log(`❌ Redis error: ${err.message}`));

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: CLIENT_URL, credentials: CLIENT_URL !== '*' }));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// ── Matchmaking helpers ───────────────────────────────────────────────────────

/**
 * Pair two sockets together:
 * - Store both directions in the Redis hash "activePairs"
 * - Emit "paired" to both sockets with each other's id
 */
async function pairSockets(socketA, partnerSocketId) {
  // Store both directions
  await redis.hset(ACTIVE_PAIRS, socketA.id, partnerSocketId);
  await redis.hset(ACTIVE_PAIRS, partnerSocketId, socketA.id);

  log(`✅ Paired  ${socketA.id}  ↔  ${partnerSocketId}`);

  // Notify both parties
  socketA.emit('paired', { partnerId: partnerSocketId });
  const partnerSocket = socketA.server.sockets.sockets.get(partnerSocketId);
  if (partnerSocket) {
    partnerSocket.emit('paired', { partnerId: socketA.id });
  }
}

/**
 * On connect: attempt to pull a waiting peer from the queue.
 * If none exists, push self onto the queue and emit "waiting".
 */
async function handleConnect(socket) {
  log(`🔌 Connected  ${socket.id}`);

  const waitingId = await redis.lpop(WAITING_QUEUE);

  if (waitingId) {
    // Make sure the waiting socket is still connected
    const waitingSocket = socket.server.sockets.sockets.get(waitingId);
    if (waitingSocket && waitingSocket.connected) {
      log(`📋 Popped from queue: ${waitingId}`);
      await pairSockets(socket, waitingId);
    } else {
      // Stale socket in queue — discard and put self in queue instead
      log(`⚠️  Stale socket in queue (${waitingId}), re-queuing self`);
      await redis.rpush(WAITING_QUEUE, socket.id);
      socket.emit('waiting');
      log(`⏳ Waiting  ${socket.id}  — queue size +1`);
    }
  } else {
    await redis.rpush(WAITING_QUEUE, socket.id);
    socket.emit('waiting');
    log(`⏳ Waiting  ${socket.id}  — queue size +1`);
  }
}

/**
 * On disconnect:
 * 1. Remove from waitingQueue (in case they were still waiting)
 * 2. If they were paired, notify partner and clean up both hash entries
 */
async function handleDisconnect(socket, reason) {
  log(`❌ Disconnected  ${socket.id}  (${reason})`);

  // 1. Remove from waiting queue (LREM key count value)
  const removed = await redis.lrem(WAITING_QUEUE, 0, socket.id);
  if (removed > 0) {
    log(`🗑️  Removed from waitingQueue: ${socket.id}`);
  }

  // 2. Check active pairs
  const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
  if (partnerId) {
    log(`💔 Breaking pair  ${socket.id}  ↔  ${partnerId}`);

    // Delete both directions
    await redis.hdel(ACTIVE_PAIRS, socket.id, partnerId);

    // Notify partner if still connected
    const partnerSocket = socket.server.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('partnerLeft');
      log(`📢 Emitted "partnerLeft" → ${partnerId}`);
    }
  }
}

// ── Socket.io ───────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: CLIENT_URL !== '*',
  },
  // Start with polling, upgrade to WebSocket — required for Render's HTTP proxy
  transports: ['polling', 'websocket'],
});

// ── Connection middleware: ban check + IP rate limiting ──────────────────────
io.use(async (socket, next) => {
  const ip = socket.handshake.address;
  try {
    // 1. Ban check — if banned, send event with remaining time and reject
    const banExpiry = await redis.get(`ban:${ip}`);
    if (banExpiry) {
      const remaining = Math.max(0, Math.ceil((parseInt(banExpiry) - Date.now()) / 60000));
      log(`🚫 Refused banned IP: ${ip} (~${remaining}m remaining)`);
      // Emit event before reject so client can show the ban overlay
      socket.emit('connectionBanned', {
        message: "You're temporarily restricted. Try again later.",
        expiresInMinutes: remaining,
      });
      return next(new Error('You have been temporarily banned'));
    }
    // 2. Rate limit: max 5 new connections per IP per 60 s
    const rlKey = `ratelimit:connect:${ip}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, 60);
    if (count > 5) {
      log(`🛑 Rate-limit hit for IP: ${ip} (count=${count})`);
      return next(new Error('Too many connections'));
    }
    next();
  } catch (err) {
    log(`❌ io.use error: ${err.message}`);
    next(); // fail-open so a Redis blip doesn't lock everyone out
  }
});

io.on('connection', async (socket) => {
  // Store IP mapping for this socket (used by report/ban logic)
  const ip = socket.handshake.address;
  await redis.set(`socketIP:${socket.id}`, ip, 'EX', 86400);

  // Broadcast updated count to everyone
  io.emit('onlineCount', io.engine.clientsCount);

  handleConnect(socket).catch((err) =>
    log(`❌ handleConnect error: ${err.message}`)
  );

  socket.on('disconnect', async (reason) => {
    // Clean up IP mapping
    await redis.del(`socketIP:${socket.id}`).catch(() => {});

    // Broadcast updated count to everyone
    io.emit('onlineCount', io.engine.clientsCount);

    handleDisconnect(socket, reason).catch((err) =>
      log(`❌ handleDisconnect error: ${err.message}`)
    );
  });

  // ── Message relay (with length guard) ─────────────────────────────────────
  socket.on('sendMessage', async ({ text, timestamp }) => {
    try {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      if (trimmed.length > MSG_MAX_LEN) {
        socket.emit('messageTooLong', { max: MSG_MAX_LEN });
        return;
      }
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) return;
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket?.connected) {
        partnerSocket.emit('receiveMessage', { text: trimmed, timestamp });
        log(`💬 Message ${socket.id} → ${partnerId} (${trimmed.length} chars)`);
      }
    } catch (err) { log(`❌ sendMessage error: ${err.message}`); }
  });

  // ── Typing indicator relay ─────────────────────────────────────────────────
  socket.on('typing', async () => {
    try {
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) return;
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket?.connected) partnerSocket.emit('partnerTyping');
    } catch (err) { log(`❌ typing error: ${err.message}`); }
  });

  // ── Skip ───────────────────────────────────────────────────────────────────────
  socket.on('skip', async () => {
    try {
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) return;
      // Break the pair
      await redis.hdel(ACTIVE_PAIRS, socket.id, partnerId);
      log(`⏭️  ${socket.id} skipped — pair broken`);
      // Notify partner + put them back in queue
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket?.connected) {
        partnerSocket.emit('partnerSkipped');
        await redis.rpush(WAITING_QUEUE, partnerId);
        partnerSocket.emit('waiting');
        log(`⏳ ${partnerId} re-queued after skip`);
      }
      // Put skipper back into matchmaking
      await handleConnect(socket);
    } catch (err) { log(`❌ skip error: ${err.message}`); }
  });

  // ── Report user ───────────────────────────────────────────────────────────
  socket.on('reportUser', async ({ reason }) => {
    try {
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) {
        socket.emit('reportReceived');
        return;
      }

      const BAN_DURATION_SECS = 900; // 15 minutes
      const BAN_DURATION_MINS = 15;
      const REPORT_THRESHOLD  = 3;

      // De-duplicate: only count each reporter once per partner per session
      const reportersKey = `reports:${partnerId}:reporters`;
      const added = await redis.sadd(reportersKey, socket.id);
      await redis.expire(reportersKey, BAN_DURATION_SECS);

      if (!added) {
        // This reporter already reported this partner — ignore silently
        socket.emit('reportReceived');
        return;
      }

      // Track reason
      const reasonsKey = `reports:${partnerId}:reasons`;
      await redis.rpush(reasonsKey, reason || 'Unspecified');
      await redis.expire(reasonsKey, BAN_DURATION_SECS);

      // Increment count
      const countKey   = `reports:${partnerId}:count`;
      const reportCount = await redis.incr(countKey);
      await redis.expire(countKey, BAN_DURATION_SECS);

      log(`🚨 Report against ${partnerId} reason="${reason}" total=${reportCount}`);

      if (reportCount >= REPORT_THRESHOLD) {
        // Look up partner IP from our stored mapping
        const partnerIp = await redis.get(`socketIP:${partnerId}`);

        if (partnerIp) {
          const banExpiry = Date.now() + BAN_DURATION_SECS * 1000;
          await redis.set(`ban:${partnerIp}`, String(banExpiry), 'EX', BAN_DURATION_SECS);
          await redis.sadd(BANNED_IPS, partnerIp);
          log(`🚫 Banned IP ${partnerIp} (socket ${partnerId}) — ${reportCount} reports, ${BAN_DURATION_MINS}m ban`);
        }

        // Notify and disconnect the reported socket
        const partnerSocket = socket.server.sockets.sockets.get(partnerId);
        if (partnerSocket && partnerSocket.connected) {
          partnerSocket.emit('youWereBanned', {
            message: "You've been temporarily restricted due to multiple reports.",
            expiresInMinutes: BAN_DURATION_MINS,
          });
          // Notify the skipper (reporter) that partner left
          socket.emit('partnerLeft');
          // Clean up their pair
          await redis.hdel(ACTIVE_PAIRS, socket.id, partnerId);
          // Remove from waiting queue if queued
          await redis.lrem(WAITING_QUEUE, 0, partnerId);
          partnerSocket.disconnect(true);
        }
      }

      socket.emit('reportReceived');
    } catch (err) { log(`❌ reportUser error: ${err.message}`); }
  });

  // ── Antigravity: generate a reconnect code ──────────────────────────────────
  socket.on('generateAntigravity', async () => {
    try {
      // Only valid if this socket is in an active pair
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) {
        log(`⚠️  generateAntigravity ignored — ${socket.id} not in a pair`);
        return;
      }

      const code   = generateCode();
      const agKey  = `ag:${code}`;
      const TTL    = 3600; // 1 hour

      // Persist pair snapshot with TTL
      await redis.set(
        agKey,
        JSON.stringify({ socketA: socket.id, socketB: partnerId }),
        'EX', TTL
      );
      // Reconnect counter (starts at 0, incremented by each joiner)
      await redis.set(`${agKey}:count`, '0', 'EX', TTL);

      log(`🔗 Antigravity code "${code}" created for pair ${socket.id} ↔ ${partnerId}`);

      // Notify both users in the pair
      socket.emit('antigravityCode', { code });
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit('antigravityCode', { code });
      }
    } catch (err) {
      log(`❌ generateAntigravity error: ${err.message}`);
    }
  });

  // ── Antigravity: join with a reconnect code ─────────────────────────────────
  socket.on('joinAntigravity', async ({ code }) => {
    try {
      if (!code || typeof code !== 'string') {
        socket.emit('antigravityError', { message: 'Invalid code format' });
        return;
      }

      const agKey    = `ag:${code.trim().toUpperCase()}`;
      const countKey = `${agKey}:count`;
      const firstKey = `${agKey}:first`;

      const pairRaw = await redis.get(agKey);
      if (!pairRaw) {
        socket.emit('antigravityError', { message: 'Code expired or invalid' });
        log(`⚠️  Antigravity join failed — code "${code}" not found`);
        return;
      }

      // Atomically increment the joiner counter
      const count = await redis.incr(countKey);

      if (count === 1) {
        // ── First rejoiner: park their socket ID and wait ─────────────────────
        const TTL = await redis.ttl(agKey); // honour remaining TTL
        await redis.set(firstKey, socket.id, 'EX', Math.max(TTL, 60));
        log(`🔗 Antigravity first rejoiner ${socket.id} (code "${code}"), waiting for partner`);
        // Keep them in a visible waiting state
        socket.emit('waiting');

      } else if (count === 2) {
        // ── Second rejoiner: fetch first, pair them, clean up ─────────────────
        const firstSocketId = await redis.get(firstKey);
        if (!firstSocketId) {
          // First socket's record expired between the two joins
          socket.emit('antigravityError', { message: 'Code expired or invalid' });
          await redis.del(agKey, countKey, firstKey);
          return;
        }

        // Register both directions in activePairs
        await redis.hset(ACTIVE_PAIRS, socket.id, firstSocketId);
        await redis.hset(ACTIVE_PAIRS, firstSocketId, socket.id);

        log(`✅ Antigravity reconnected: ${socket.id} ↔ ${firstSocketId} (code "${code}")`);

        // Notify both with antigravity flag so the client shows the right message
        socket.emit('paired', { antigravity: true });
        const firstSocket = socket.server.sockets.sockets.get(firstSocketId);
        if (firstSocket && firstSocket.connected) {
          firstSocket.emit('paired', { antigravity: true });
        }

        // Clean up all Antigravity keys
        await redis.del(agKey, countKey, firstKey);
        log(`🗑️  Antigravity keys deleted for code "${code}"`);

      } else {
        // More than 2 attempts — reject and roll back the counter
        await redis.decr(countKey);
        socket.emit('antigravityError', { message: 'Code already used' });
        log(`⚠️  Antigravity code "${code}" already fully claimed`);
      }
    } catch (err) {
      log(`❌ joinAntigravity error: ${err.message}`);
      socket.emit('antigravityError', { message: 'Something went wrong, please try again' });
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`🚀 Server listening on http://localhost:${PORT}`);
});
