import { readEnv } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { createLogger } from './lib/logger.js';
import { buildApp } from './http/app.js';
import { seedDatabase } from './db/seed.js';
import { seedRequestHistory } from './db/seedHistory.js';
import { seedShop } from './shop/seed.js';
import { purgeExpiredSessions } from './shop/auth.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Process entrypoint.
 *
 * Seeding is idempotent and relative to "now", so a fresh checkout that runs
 * `pnpm start` gets a working demo without a separate manual step, while an
 * existing database is left alone.
 */
const env = readEnv();

async function main(): Promise<void> {
  const log = createLogger(env.LOG_LEVEL);
  const db = openDatabase(env.DATABASE_PATH);

  if (countRows(db) === 0) {
    const seeded = seedDatabase(db, new Date());
    log.info({ seeded }, 'database.seeded');
    // A few recorded decisions, so the console opens onto history rather than an
    // empty table. Replayed from the canonical scenarios, never from a model.
    const history = seedRequestHistory(db, new Date());
    log.info({ history }, 'database.seeded.history');
  }

  // The storefront catalogue and demo accounts are additive, so they are topped
  // up on every boot rather than only on a fresh database.
  const shop = seedShop(db, new Date());
  log.info(shop, 'shop.seeded');
  const expired = purgeExpiredSessions(db, new Date());
  if (expired > 0) {
    log.info({ expired }, 'shop.sessions.purged');
  }

  const app = buildApp({ env, db, staticDir: webDistDir(), shopDir: shopDistDir() });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutdown.start');
    void app.close().then(() => {
      db.close();
      log.info('shutdown.complete');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  log.info({ port: env.API_PORT, ai: `${env.AI_PROVIDER}` }, 'server.listening');
}

function countRows(db: ReturnType<typeof openDatabase>): number {
  const row: unknown = db.prepare('SELECT COUNT(*) AS n FROM customers').get();
  return typeof row === 'object' && row !== null && 'n' in row ? Number(row.n) : 0;
}

/**
 * The storefront, mounted at `/shop/`. Same deal as the staff console: present
 * in the single-container image, absent in development where Vite serves it.
 */
function shopDistDir(): string {
  const dir = fileURLToPath(new URL('../../shop/dist/', import.meta.url));
  return existsSync(dir) ? dir : '/nonexistent';
}

/**
 * Present in the single-container image, absent in development.
 *
 * `fileURLToPath` rather than `URL.pathname`: pathname is percent-encoded, so a
 * checkout under a path containing a space would resolve to a directory that
 * does not exist and the app would quietly serve nothing but the API.
 */
function webDistDir(): string {
  if (env.WEB_STATIC_DIR !== undefined) {
    return env.WEB_STATIC_DIR;
  }
  const dir = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  return existsSync(dir) ? dir : '/nonexistent';
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
