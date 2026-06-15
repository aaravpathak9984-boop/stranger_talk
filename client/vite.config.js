import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Only proxy /socket.io in local dev (when VITE_SERVER_URL is not set).
  // In production the env var points directly to the Render server, so no proxy needed.
  const devProxy = env.VITE_SERVER_URL
    ? {}
    : {
        '/socket.io': {
          target: 'http://localhost:3001',
          ws: true,
          changeOrigin: true,
        },
      }

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      proxy: devProxy,
    },
  }
})
