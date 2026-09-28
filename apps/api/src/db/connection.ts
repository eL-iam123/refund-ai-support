import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

import { LATEST_VERSION } from './migrations.js';

/**
 * Schema lives in TypeScript rather than a .sql file so that `tsc` alone is
 * enough to produce a runnable build - no asset copying step in Docker.
 *
 * This block is the *base* schema only. Anything added after a database was
 * first created belongs in `migrations.ts`: an `IF NOT EXISTS` table is never
 * altered, so a new column here would only ever reach a database that does not
 * exist yet.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  email                     TEXT NOT NULL,
  tier                      TEXT NOT NULL,
  account_created_at        TEXT NOT NULL,
  prior_refund_count        INTEGER NOT NULL DEFAULT 0,
  refund_requests_last_30d  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  placed_at             TEXT NOT NULL,
  delivered_at          TEXT,
  status                TEXT NOT NULL,
  payment_state         TEXT NOT NULL,
  refunded_cents        INTEGER NOT NULL DEFAULT 0,
  is_subscription       INTEGER NOT NULL DEFAULT 0,
  tracking_status       TEXT NOT NULL,
  signed_by_customer    INTEGER NOT NULL DEFAULT 0,
  condition_at_delivery TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL,
  final_sale       INTEGER NOT NULL DEFAULT 0,
  digital          INTEGER NOT NULL DEFAULT 0,
  downloaded       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS refund_requests (
  id                      TEXT PRIMARY KEY,
  created_at              TEXT NOT NULL,
  customer_id             TEXT NOT NULL,
  order_id                TEXT,
  message                 TEXT NOT NULL,
  message_sha256          TEXT NOT NULL,
  decision                TEXT NOT NULL,
  refund_amount_cents     INTEGER NOT NULL,
  -- The order-derived eligible amount, added by migration 1. Kept separately
  -- from the refund amount because it is a fact about the order, not a
  -- consequence of the decision: once a decision is 'denied' the refund amount
  -- is 0, and the eligible figure is still what a human needs to override it.
  eligible_amount_cents   INTEGER NOT NULL,
  summary                 TEXT NOT NULL,
  policy_ref              TEXT NOT NULL,
  trace_json              TEXT NOT NULL,
  overrides_json          TEXT NOT NULL,
  eligible_item_ids_json  TEXT NOT NULL,
  blocked_items_json      TEXT NOT NULL,
  response_text           TEXT NOT NULL,
  extraction_json         TEXT,
  grounding_json          TEXT,
  injection_json          TEXT NOT NULL,
  ai_mode                 TEXT NOT NULL,
  llm_called              INTEGER NOT NULL,
  timings_json            TEXT NOT NULL,
  overridden_by           TEXT,
  override_note           TEXT,
  scenario_id             TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON refund_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON refund_requests(customer_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id        TEXT NOT NULL,
  at                TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  attempt           INTEGER NOT NULL,
  ok                INTEGER NOT NULL,
  latency_ms        INTEGER NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_request ON llm_calls(request_id);
`;

export type Db = Database.Database;

export function openDatabase(path: string, log?: (message: string) => void): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db, log);
  return db;
}

/** Test helper: a throwaway in-memory database. */
export function openMemoryDatabase(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** The schema version this build expects, for `/api/health` and diagnostics. */
export const SCHEMA_VERSION = LATEST_VERSION;
