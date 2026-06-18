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

/** Generate a random 6-character uppercase alphanumeric code */
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

redis.on('connect', () => log('Redis connected'));
redis.on('error', (err) => log(`Redis error: ${err.message}`));

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

// ── Lua scripts — atomic Redis operations ─────────────────────────────────────

/**
 * matchScript — atomic matchmaking
 * KEYS[1] = waitingQueue, KEYS[2] = activePairs, ARGV[1] = socket.id
 *
 * Executes as a SINGLE uninterruptible Redis operation:
 *  - Queue non-empty: LPOP the first waiter, write both pair directions into
 *    activePairs via HSET, return the waiter's id.
 *  - Queue empty: RPUSH this socket onto the queue, return false.
 *
 * Because Redis Lua scripts are atomic, no two callers can pop the same
 * waiter or both observe an empty queue simultaneously — the race condition
 * in the old LPOP + separate HSET sequence is fully eliminated.
 */
const matchScript = `
  local waiting = redis.call('LPOP', KEYS[1])
  if waiting then
    redis.call('HSET', KEYS[2], ARGV[1], waiting)
    redis.call('HSET', KEYS[2], waiting, ARGV[1])
    return waiting
  else
    redis.call('RPUSH', KEYS[1], ARGV[1])
    return false
  end
`;

/**
 * teardownScript — atomic pair cleanup
 * KEYS[1] = activePairs, ARGV[1] = socket.id
 *
 * Atomically: fetch the partner for this socket, delete both pair directions,
 * return the partner id (or false if none). Eliminates the HGET -> HDEL window
 * that concurrent skip or disconnect handlers could interleave through.
 */
const teardownScript = `
  local partner = redis.call('HGET', KEYS[1], ARGV[1])
  if partner then
    redis.call('HDEL', KEYS[1], ARGV[1], partner)
    return partner
  end
  return false
`;

// ── Matchmaking helpers ───────────────────────────────────────────────────────

/**
 * Atomically attempt to match this socket via matchScript.
 *
 * If the script returns a partnerId and that partner is still live, emit
 * 'paired' to both and done. If the partner is stale (disconnected between
 * their RPUSH and our LPOP), clean up the orphaned pair entries and recurse
 * once so this socket gets another shot. On miss, the script queues the
 * socket and we emit 'waiting'.
 */
async function handleConnect(socket) {
  log(`[match] attempt  ${socket.id}`);

  const partnerId = await redis.eval(
    matchScript, 2,
    WAITING_QUEUE, ACTIVE_PAIRS,
    socket.id
  );

  if (!partnerId) {
    socket.emit('waiting');
    log(`[match] queued   ${socket.id}`);
    return;
  }

  // Verify the matched socket is still live in this process
  const partnerSocket = socket.server.sockets.sockets.get(partnerId);
  if (partnerSocket && partnerSocket.connected) {
    log(`[match] paired   ${socket.id} <-> ${partnerId}`);
    socket.emit('paired', {});
    partnerSocket.emit('paired', {});
  } else {
    // Stale: clean up the pair entries the Lua script wrote, then retry.
    log(`[match] stale    ${partnerId} — retrying for ${socket.id}`);
    await redis.hdel(ACTIVE_PAIRS, socket.id, partnerId).catch(() => {});
    await handleConnect(socket); // one recursion; very unlikely to hit twice
  }
}

/**
 * Atomically fetch + delete the pair entry for a socket.
 * Returns partnerId string or null.
 */
async function teardownPair(socketId) {
  const result = await redis.eval(teardownScript, 1, ACTIVE_PAIRS, socketId);
  return result || null;
}

/**
 * On disconnect:
 * 1. LREM from waitingQueue — single atomic call, no race.
 * 2. Atomic teardown of any active pair via teardownScript.
 * 3. Notify partner if still connected.
 */
async function handleDisconnect(socket, reason) {
  log(`[disc]  ${socket.id} (${reason})`);

  const removed = await redis.lrem(WAITING_QUEUE, 0, socket.id);
  if (removed > 0) log(`[disc]  removed from waitingQueue: ${socket.id}`);

  const partnerId = await teardownPair(socket.id);
  if (partnerId) {
    log(`[disc]  breaking pair  ${socket.id} <-> ${partnerId}`);
    const partnerSocket = socket.server.sockets.sockets.get(partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('partnerLeft');
      log(`[disc]  emitted partnerLeft -> ${partnerId}`);
    }
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: CLIENT_URL !== '*',
  },
  // Start with polling, upgrade to WebSocket — required for Render's HTTP proxy
  transports: ['polling', 'websocket'],
});

// ── Connection middleware: ban check + IP rate limiting ───────────────────────
io.use(async (socket, next) => {
  const ip = socket.handshake.address;
  try {
    // 1. Ban check
    const banExpiry = await redis.get(`ban:${ip}`);
    if (banExpiry) {
      const remaining = Math.max(0, Math.ceil((parseInt(banExpiry) - Date.now()) / 60000));
      log(`[ban]   refused ${ip} (~${remaining}m remaining)`);
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
      log(`[rl]    rate-limit hit for ${ip} (count=${count})`);
      return next(new Error('Too many connections'));
    }
    next();
  } catch (err) {
    log(`[err]   io.use: ${err.message}`);
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
    log(`[err]   handleConnect: ${err.message}`)
  );

  socket.on('disconnect', async (reason) => {
    await redis.del(`socketIP:${socket.id}`).catch(() => {});
    io.emit('onlineCount', io.engine.clientsCount);
    handleDisconnect(socket, reason).catch((err) =>
      log(`[err]   handleDisconnect: ${err.message}`)
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
        log(`[msg]   ${socket.id} -> ${partnerId} (${trimmed.length} chars)`);
      }
    } catch (err) { log(`[err]   sendMessage: ${err.message}`); }
  });

  // ── Typing indicator relay ─────────────────────────────────────────────────
  socket.on('typing', async () => {
    try {
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) return;
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket?.connected) partnerSocket.emit('partnerTyping');
    } catch (err) { log(`[err]   typing: ${err.message}`); }
  });

  // ── Skip ──────────────────────────────────────────────────────────────────
  socket.on('skip', async () => {
    try {
      // Atomically get + delete the pair so no concurrent disconnect can
      // interleave between the HGET and the HDEL
      const partnerId = await teardownPair(socket.id);
      if (!partnerId) return;

      log(`[skip]  ${socket.id} -> ${partnerId}`);

      // Notify the skipped partner and put them back into matchmaking
      // (they may pair instantly with someone already in the queue)
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket?.connected) {
        partnerSocket.emit('partnerSkipped');
        await handleConnect(partnerSocket);
        log(`[skip]  ${partnerId} re-entered matchmaking`);
      }

      // Put the skipper back into matchmaking as well
      await handleConnect(socket);
    } catch (err) { log(`[err]   skip: ${err.message}`); }
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
        socket.emit('reportReceived');
        return;
      }

      // Track reason
      const reasonsKey = `reports:${partnerId}:reasons`;
      await redis.rpush(reasonsKey, reason || 'Unspecified');
      await redis.expire(reasonsKey, BAN_DURATION_SECS);

      // Increment count
      const countKey    = `reports:${partnerId}:count`;
      const reportCount = await redis.incr(countKey);
      await redis.expire(countKey, BAN_DURATION_SECS);

      log(`[report] against ${partnerId} reason="${reason}" total=${reportCount}`);

      if (reportCount >= REPORT_THRESHOLD) {
        const partnerIp = await redis.get(`socketIP:${partnerId}`);
        if (partnerIp) {
          const banExpiry = Date.now() + BAN_DURATION_SECS * 1000;
          await redis.set(`ban:${partnerIp}`, String(banExpiry), 'EX', BAN_DURATION_SECS);
          await redis.sadd(BANNED_IPS, partnerIp);
          log(`[ban]   ${partnerIp} (socket ${partnerId}) — ${reportCount} reports, ${BAN_DURATION_MINS}m`);
        }

        const partnerSocket = socket.server.sockets.sockets.get(partnerId);
        if (partnerSocket && partnerSocket.connected) {
          partnerSocket.emit('youWereBanned', {
            message: "You've been temporarily restricted due to multiple reports.",
            expiresInMinutes: BAN_DURATION_MINS,
          });
          socket.emit('partnerLeft');
          await redis.hdel(ACTIVE_PAIRS, socket.id, partnerId);
          await redis.lrem(WAITING_QUEUE, 0, partnerId);
          partnerSocket.disconnect(true);
        }
      }

      socket.emit('reportReceived');
    } catch (err) { log(`[err]   reportUser: ${err.message}`); }
  });

  // ── Antigravity: generate a reconnect code ────────────────────────────────
  socket.on('generateAntigravity', async () => {
    try {
      const partnerId = await redis.hget(ACTIVE_PAIRS, socket.id);
      if (!partnerId) {
        log(`[ag]    generateAntigravity ignored — ${socket.id} not in a pair`);
        return;
      }

      const code  = generateCode();
      const agKey = `ag:${code}`;
      const TTL   = 3600; // 1 hour

      await redis.set(
        agKey,
        JSON.stringify({ socketA: socket.id, socketB: partnerId }),
        'EX', TTL
      );
      await redis.set(`${agKey}:count`, '0', 'EX', TTL);

      log(`[ag]    code "${code}" created for ${socket.id} <-> ${partnerId}`);

      socket.emit('antigravityCode', { code });
      const partnerSocket = socket.server.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit('antigravityCode', { code });
      }
    } catch (err) {
      log(`[err]   generateAntigravity: ${err.message}`);
    }
  });

  // ── Antigravity: join with a reconnect code ───────────────────────────────
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
        log(`[ag]    join failed — code "${code}" not found`);
        return;
      }

      const count = await redis.incr(countKey);

      if (count === 1) {
        const TTL = await redis.ttl(agKey);
        await redis.set(firstKey, socket.id, 'EX', Math.max(TTL, 60));
        log(`[ag]    first rejoiner ${socket.id} (code "${code}")`);
        socket.emit('waiting');

      } else if (count === 2) {
        const firstSocketId = await redis.get(firstKey);
        if (!firstSocketId) {
          socket.emit('antigravityError', { message: 'Code expired or invalid' });
          await redis.del(agKey, countKey, firstKey);
          return;
        }

        await redis.hset(ACTIVE_PAIRS, socket.id, firstSocketId);
        await redis.hset(ACTIVE_PAIRS, firstSocketId, socket.id);

        log(`[ag]    reconnected ${socket.id} <-> ${firstSocketId} (code "${code}")`);

        socket.emit('paired', { antigravity: true });
        const firstSocket = socket.server.sockets.sockets.get(firstSocketId);
        if (firstSocket && firstSocket.connected) {
          firstSocket.emit('paired', { antigravity: true });
        }

        await redis.del(agKey, countKey, firstKey);
        log(`[ag]    keys deleted for code "${code}"`);

      } else {
        await redis.decr(countKey);
        socket.emit('antigravityError', { message: 'Code already used' });
        log(`[ag]    code "${code}" already fully claimed`);
      }
    } catch (err) {
      log(`[err]   joinAntigravity: ${err.message}`);
      socket.emit('antigravityError', { message: 'Something went wrong, please try again' });
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
});
