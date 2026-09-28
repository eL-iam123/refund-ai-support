import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // No `test.env` here on purpose. Setting provider variables in this file
    // would outrank the real `.env` inside the test process, so the opt-in live
    // suite would silently call the wrong provider with a placeholder key.
    // `testEnv()` in src/test/helpers.ts sets what the offline suite needs, and
    // the live suite reads the operator's own configuration.
  },
});
