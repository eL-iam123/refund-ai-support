import { readEnv } from '../config/env.js';
import { openDatabase } from './connection.js';
import { seedCatalogue } from '../shop/seed.js';
import { createLogger } from '../lib/logger.js';

/**
 * The only seed this deployment ships with: the storefront items.
 *
 * Demo customers, their orders, the scenario CRM fixtures and the recorded
 * decision history are deliberately *not* seeded. A fresh deployment should
 * contain a shop and nothing else, so that everything appearing afterwards is
 * something a real person did rather than something that was quietly invented to
 * make the system look busy.
 *
 * Boot seeds this same catalogue, so running it by hand is only needed to pull
 * in items added since the process started, or to repair a bare table without a
 * restart. It is idempotent and safe to re-run.
 *
 * Dev:    pnpm seed
 * Docker: docker compose exec api node apps/api/dist/db/seed-cli.js
 */
function main(): void {
  const env = readEnv();
  const log = createLogger(env.LOG_LEVEL);
  const db = openDatabase(env.DATABASE_PATH);

  const products = seedCatalogue(db);
  log.info({ products, database: env.DATABASE_PATH }, 'seed.complete');

  db.close();
}

main();
