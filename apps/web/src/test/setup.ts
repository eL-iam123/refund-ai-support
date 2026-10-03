import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Per-test teardown.
 *
 * React Testing Library does not unmount between tests by itself, and a storefront
 * whose previous test's socket and timers are still alive is a suite that passes for
 * the wrong reason and fails for an unrelated one.
 */
afterEach(() => {
  cleanup();
});