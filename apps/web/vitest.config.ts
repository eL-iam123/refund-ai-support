import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The storefront's own test environment.
 *
 * Separate from `vite.config.ts` on purpose: the dev server's proxy and the build's
 * output settings are irrelevant to a test, and folding them together means every test
 * run boots a proxy it never talks to. `jsdom` because the storefront is a browser
 * application - a test that ran in node would pass against code that cannot render.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    // Component tests share one process and one jsdom per worker, so the pool is kept
    // small and the per-test cost stays visible rather than hidden in a wall time.
    pool: 'threads',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});