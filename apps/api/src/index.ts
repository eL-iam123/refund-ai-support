import { readEnv, isAiRequired, missingApiKeyFor } from './config/env.js';
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

  // Said once, loudly, and only when it is actually true. The degraded mode is
  // deliberate and defensible - requests still get answered, and anything the
  // model would have read is escalated to a person rather than guessed at. What
  // is not defensible is it being invisible: a deployment can look perfectly
  // healthy while paying for a model it never reaches. `readEnv` has already
  // refused to start for this when the process is required to have one, so
  // reaching here means someone chose the degraded mode, and they should know
  // they chose it.
  const missingKey = missingApiKeyFor(env);
  if (missingKey !== null) {
    log.error(
      { provider: env.AI_PROVIDER, required: isAiRequired(env) },
      `ai.unavailable: ${missingKey}. Every request that needs a claim will escalate to a ` +
        'person instead of being read by a model. Set the key to restore it.',
    );
  }

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

  const app = buildApp({ env, db, staticDir: webDistDir() });

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
 * The client, served from the same origin as the API.
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
