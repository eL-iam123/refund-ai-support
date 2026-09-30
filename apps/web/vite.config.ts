import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` to the Fastify process so the browser sees one
 * origin. That keeps the CORS configuration out of the development loop
 * entirely: the same relative URLs work in dev, in Docker behind nginx, and
 * when the API serves the built bundle itself.
 *
 * `ws: true` does the same for the chat WebSockets: `ws://localhost:5173/api/...`
 * is forwarded to the API process, so the shop and the staff console both just
 * use relative URLs and the session cookies (which the proxy forwards untouched)
 * stay first-party.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
