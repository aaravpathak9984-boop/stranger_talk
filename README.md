# StrangerTalk

Anonymous real-time chat — no account, no trace, just conversation.

Built with **React + Vite** (client), **Node.js + Express + Socket.io** (server), and **Redis** for matchmaking state.

---

## Local Development

### Prerequisites

| Tool | Install |
|---|---|
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |
| Redis | `brew install redis` (macOS) |

### Start Redis

```bash
brew services start redis   # macOS — runs in background, restarts on login
# or: redis-server           # foreground
redis-cli ping              # should return PONG
```

### Run both server and client

```bash
cd stranger_talk
npm run dev          # starts server (port 3001) + client (port 5173) concurrently
```

Or individually:

```bash
# Terminal 1
cd server && npm run dev    # nodemon, hot-reloads on changes

# Terminal 2
cd client && npm run dev    # Vite HMR
```

The Vite dev server automatically proxies `/socket.io` → `http://localhost:3001`.

---

## Environment Variables

### Server (`/server/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port the server listens on |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `CLIENT_URL` | `*` | Allowed CORS origin (set to your Vercel URL in production) |

### Client (`/client/.env`)

| Variable | Default | Description |
|---|---|---|
| `VITE_SERVER_URL` | `""` (empty) | Socket.io server URL. Empty = use Vite proxy in dev. Set to your Render URL in production. |

---

## Deployment

### 1. Redis — Upstash (free tier)

1. Sign up at [upstash.com](https://upstash.com)
2. Create a new Redis database (region closest to your server)
3. Copy the **Redis URL** (format: `rediss://...`) — you'll use it as `REDIS_URL`

### 2. Server — Render

1. Push this repo to GitHub
2. New Web Service → connect your repo → set **Root Directory** to `server`
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Set environment variables:
   ```
   PORT        = (Render sets this automatically)
   REDIS_URL   = rediss://...  (from Upstash)
   CLIENT_URL  = https://your-app.vercel.app
   ```
6. Deploy — note the service URL (e.g. `https://stranger-talk.onrender.com`)

### 3. Client — Vercel

1. New Project → import your repo → set **Root Directory** to `client`
2. **Build command:** `npm run build`
3. **Output directory:** `dist`
4. Set environment variables:
   ```
   VITE_SERVER_URL = https://stranger-talk.onrender.com
   ```
5. Deploy

### 4. Update CORS on Render

Go back to Render → Environment → update:
```
CLIENT_URL = https://your-actual-vercel-url.vercel.app
```
Redeploy the server.

---

## Architecture

```
Client (Vercel)           Server (Render)         Redis (Upstash)
   React + Vite     ←→    Express + Socket.io  ←→  waitingQueue
   socket.io-client        matchmaking logic        activePairs
                           Antigravity codes        ag:{code}
                           ban / rate limiting      bannedIP:{ip}
```

## Socket.io Events

| Event | Direction | Payload |
|---|---|---|
| `waiting` | server → client | — |
| `paired` | server → both | `{ matchedOn?: string, antigravity?: bool }` |
| `receiveMessage` | server → client | `{ text, timestamp }` |
| `partnerTyping` | server → client | — |
| `partnerLeft` | server → client | — |
| `partnerSkipped` | server → client | — |
| `onlineCount` | server → client | `number` |
| `sendMessage` | client → server | `{ text, timestamp }` |
| `typing` | client → server | — |
| `skip` | client → server | — |
| `reportUser` | client → server | `{ reason }` |
| `generateAntigravity` | client → server | — |
| `joinAntigravity` | client → server | `{ code }` |
| `antigravityCode` | server → both | `{ code }` |
| `antigravityError` | server → client | `{ message }` |
# stranger_talk
