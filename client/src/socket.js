import { io } from 'socket.io-client';

// In dev (VITE_SERVER_URL unset) Vite's proxy handles /socket.io → localhost:3001.
// In production set VITE_SERVER_URL to the Render service URL.
const URL = import.meta.env.VITE_SERVER_URL || '';

export const socket = io(URL, {
  autoConnect: false,
  // Start with HTTP long-polling then upgrade to WebSocket.
  // Required for Render's proxy and most reverse-proxy environments.
  transports: ['polling', 'websocket'],
});
