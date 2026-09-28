import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` to the Fastify process so the browser sees one
 * origin. That keeps the CORS configuration out of the development loop
 * entirely: the same relative URLs work in dev, in Docker behind nginx, and
 * when the API serves the built bundle itself.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
