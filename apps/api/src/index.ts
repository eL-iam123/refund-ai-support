import { readEnv, isAiRequired, missingApiKeyFor } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { createLogger } from './lib/logger.js';
import { buildApp } from './http/app.js';
import { seedCatalogue } from './shop/seed.js';
import { purgeExpiredSessions } from './shop/auth.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Process entrypoint.
 *
 * Boot seeds the storefront catalogue and nothing else. The items are the shop's
 * stock, not invented activity: seeding is idempotent and additive and leaves
 * existing stock alone, so a fresh volume gets a shop and an existing one picks
 * up items added since. Customers, orders and decision history are never seeded
 * — those only ever come from real use.
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

  // The shop's stock, and the only thing that seeds on boot. Idempotent and
  // additive, so a fresh volume opens onto a shop and an existing one gains any
  // item added since - while stock that a checkout already sold stays sold.
  const products = seedCatalogue(db);
  log.info({ products }, 'catalogue.seeded');

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
