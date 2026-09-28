import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The storefront is mounted at `/shop/` by the API process, so the base path is
 * fixed here rather than derived: a relative base would 404 every asset as soon
 * as the router navigated to a nested route.
 *
 * In development the dev server proxies `/api` to the API so the session cookie
 * stays same-origin, exactly as it is in the single-container deployment.
 */
const apiTarget = process.env.API_ORIGIN ?? 'http://localhost:4000';

export default defineConfig({
  base: '/shop/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
