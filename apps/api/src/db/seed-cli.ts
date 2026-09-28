import { readEnv } from '../config/env.js';
import { openDatabase, type Db } from './connection.js';
import { queryOne } from './sql.js';
import { seedDatabase } from './seed.js';
import { createLogger } from '../lib/logger.js';

/**
 * `pnpm seed`. Seeds the mock CRM from the scenario fixtures.
 *
 * Dates are relative to run time, so this is safe to re-run at any point: it
 * wipes the derived tables and rewrites the fixture orders relative to *now*.
 */
function main(): void {
  const env = readEnv();
  const log = createLogger(env.LOG_LEVEL);
  const db = openDatabase(env.DATABASE_PATH);
  const now = new Date();

  const scenarios = seedDatabase(db, now);
  log.info(
    {
      scenarios,
      customers: countRows(db, 'customers'),
      orders: countRows(db, 'orders'),
      items: countRows(db, 'order_items'),
      database: env.DATABASE_PATH,
    },
    'seed.complete',
  );
  db.close();
}

function countRows(db: Db, table: string): number {
  const row = queryOne<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`));
  return row?.n ?? 0;
}

main();
