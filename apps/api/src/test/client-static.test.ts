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
 * Serving the storefront from the API process.
 *
 * The reason the shop lives on this origin rather than a separate domain is the
 * session cookie: same-origin means the browser sends it without a CORS dance
 * and without a third-party-cookie policy getting in the way. That only works if
 * the API can actually serve the shop's files, so it is tested rather than
 * assumed - a build that emitted an HTML fallback for the JavaScript bundle would
 * look identical from the shell and be a blank page in a browser.
 *
 * Skipped when the storefront has not been built, because `pnpm test` does not
 * build it and a fresh clone has no `dist` to serve.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOP_DIST = resolve(HERE, '../../../shop/dist');
const BUILT = existsSync(join(SHOP_DIST, 'index.html'));

/** A file name from the built asset folder, or null if the build has none. */
function builtAsset(extension: 'js' | 'css'): string | null {
  const dir = join(SHOP_DIST, 'assets');
  if (!existsSync(dir)) {
    return null;
  }
  return readdirSync(dir).find((name) => name.endsWith(`.${extension}`)) ?? null;
}

describe.skipIf(!BUILT)('the storefront is served from the API origin', () => {
  let harness: AppHarness;

  beforeAll(async () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    const app = buildApp({ env: testEnv(), db, logger: silentLogger, now: (): Date => TEST_NOW, shopDir: SHOP_DIST });
    await app.ready();
    harness = { app, db };
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('serves the storefront shell at /shop', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/shop/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves the shell for a bare /shop with no trailing slash', async () => {
    // The static prefix would not match a bare `/shop`, and a redirect here would
    // drop the session cookie on a cross-origin-ish hop.
    const response = await harness.app.inject({ method: 'GET', url: '/shop' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves client-side routes as the shell so a deep link works', async () => {
    for (const path of ['/shop/cart', '/shop/orders', '/shop/account']) {
      const response = await harness.app.inject({ method: 'GET', url: path });

      expect(response.statusCode, path).toBe(200);
      expect(response.headers['content-type'], path).toContain('text/html');
    }
  });

  it('serves the JavaScript bundle as JavaScript, not as the HTML fallback', async () => {
    const asset = builtAsset('js');
    expect(asset, 'run `pnpm --filter @refund/shop build` first').not.toBeNull();

    const response = await harness.app.inject({ method: 'GET', url: `/shop/assets/${asset ?? ''}` });

    expect(response.statusCode).toBe(200);
    // The bug this catches: the SPA fallback answering for a real file, which
    // hands the browser HTML where it expects a module and renders a blank page.
    expect(response.headers['content-type']).toMatch(/javascript|ecmascript/);
  });

  it('serves the stylesheet as CSS', async () => {
    const asset = builtAsset('css');
    expect(asset, 'run `pnpm --filter @refund/shop build` first').not.toBeNull();

    const response = await harness.app.inject({ method: 'GET', url: `/shop/assets/${asset ?? ''}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/css');
  });

  it('keeps API 404s as JSON rather than handing back the shop', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/shop/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('does not let a shop path shadow a real API route', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/shop/products' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
