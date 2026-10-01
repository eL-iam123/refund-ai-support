import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // The API suite is 34 files and the development/test container commonly
    // has 4 CPUs. Letting Vitest spawn one worker per file causes avoidable CPU
    // contention and flakes the 5s integration-test timeout; cap concurrency at
    // the available host-sized baseline rather than multiplying processes.
    maxWorkers: 4,
    // No `test.env` here on purpose. Setting provider variables in this file
    // would outrank the real `.env` inside the test process, so the opt-in live
    // suite would silently call the wrong provider with a placeholder key.
    // `testEnv()` in src/test/helpers.ts sets what the offline suite needs, and
    // the live suite reads the operator's own configuration.
  },
});
