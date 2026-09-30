import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { buildApp } from '../http/app.js';
import { testEnv, TEST_NOW } from './helpers.js';
import { silentLogger } from '../lib/logger.js';
import type { AppHarness } from './helpers.js';

/**
 * Serving the client from the API origin.
 *
 * The shop, the cart, the order history and the assistant are one bundle on one
 * origin, so the session cookie that ties an order to a refund request is
 * first-party. That only holds if the API can actually serve the built files, so
 * it is tested rather than assumed: a build that emitted an HTML fallback for the
 * JavaScript bundle would look identical from the shell and be a blank page in a
 * browser.
 *
 * Skipped when the client has not been built, because `pnpm test` does not build
 * it and a fresh clone has no `dist` to serve.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(HERE, '../../../web/dist');
const BUILT = existsSync(join(CLIENT_DIST, 'index.html'));

/** A file name from the built asset folder, or null if the build has none. */
function builtAsset(extension: 'js' | 'css'): string | null {
  const dir = join(CLIENT_DIST, 'assets');
  if (!existsSync(dir)) {
    return null;
  }
  return readdirSync(dir).find((name) => name.endsWith(`.${extension}`)) ?? null;
}

describe.skipIf(!BUILT)('the client is served from the API origin', () => {
  let harness: AppHarness;

  beforeAll(async () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    const app = buildApp({
      env: testEnv(),
      db,
      logger: silentLogger,
      now: (): Date => TEST_NOW,
      staticDir: CLIENT_DIST,
    });
    await app.ready();
    harness = { app, db, analyzerCalls: () => 0 };
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('serves the shop at the root', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves client-side routes as the shell so a deep link works', async () => {
    for (const path of ['/cart', '/orders', '/help', '/admin/requests']) {
      const response = await harness.app.inject({ method: 'GET', url: path });

      expect(response.statusCode, path).toBe(200);
      expect(response.headers['content-type'], path).toContain('text/html');
    }
  });

  it('serves the JavaScript bundle as JavaScript, not as the HTML fallback', async () => {
    const asset = builtAsset('js');
    expect(asset, 'run `pnpm --filter @refund/web build` first').not.toBeNull();

    const response = await harness.app.inject({ method: 'GET', url: `/assets/${asset ?? ''}` });

    expect(response.statusCode).toBe(200);
    // The bug this catches: the SPA fallback answering for a real file, which
    // hands the browser HTML where it expects a module and renders a blank page.
    expect(response.headers['content-type']).toMatch(/javascript|ecmascript/);
  });

  it('serves the stylesheet as CSS', async () => {
    const asset = builtAsset('css');
    expect(asset, 'run `pnpm --filter @refund/web build` first').not.toBeNull();

    const response = await harness.app.inject({ method: 'GET', url: `/assets/${asset ?? ''}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/css');
  });

  it('keeps API 404s as JSON rather than handing back the client', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/shop/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('does not let a client-side route shadow a real API route', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/shop/products' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
