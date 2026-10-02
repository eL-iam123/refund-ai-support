import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, openMemoryDatabase, SCHEMA_VERSION } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { insertRequest } from '../db/requestRepository.js';
import { LATEST_VERSION, migrate } from '../db/migrations.js';

/**
 * Migration.
 *
 * The bug this guards against is not hypothetical: an on-disk development
 * database created before `eligible_amount_cents` existed produced
 * `SQLITE_ERROR` on every request and every audit write, while the entire test
 * suite passed - because tests build a fresh in-memory database, which is always
 * already current. A migration is therefore only proven by migrating something
 * that is genuinely old.
 */

/** The schema as it looked before the eligible-amount column was added. */
const LEGACY_SCHEMA = `
CREATE TABLE customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tier TEXT NOT NULL,
  account_created_at TEXT NOT NULL, prior_refund_count INTEGER NOT NULL DEFAULT 0,
  refund_requests_last_30d INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, placed_at TEXT NOT NULL,
  delivered_at TEXT, status TEXT NOT NULL, payment_state TEXT NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0, is_subscription INTEGER NOT NULL DEFAULT 0,
  tracking_status TEXT NOT NULL, signed_by_customer INTEGER NOT NULL DEFAULT 0,
  condition_at_delivery TEXT
);
CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL,
  final_sale INTEGER NOT NULL DEFAULT 0, digital INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, customer_id TEXT NOT NULL, order_id TEXT,
  message TEXT NOT NULL, message_sha256 TEXT NOT NULL, decision TEXT NOT NULL,
  refund_amount_cents INTEGER NOT NULL, summary TEXT NOT NULL, policy_ref TEXT NOT NULL,
  trace_json TEXT NOT NULL, overrides_json TEXT NOT NULL, eligible_item_ids_json TEXT NOT NULL,
  blocked_items_json TEXT NOT NULL, response_text TEXT NOT NULL, extraction_json TEXT,
  grounding_json TEXT, injection_json TEXT NOT NULL, ai_mode TEXT NOT NULL,
  llm_called INTEGER NOT NULL, timings_json TEXT NOT NULL, overridden_by TEXT,
  override_note TEXT, scenario_id TEXT
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, at TEXT NOT NULL,
  purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, attempt INTEGER NOT NULL,
  ok INTEGER NOT NULL, latency_ms INTEGER NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER,
  error TEXT
);
`;

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_SCHEMA);
  return db;
}

function insertLegacyRequest(
  db: Database.Database,
  id: string,
  decision: string,
  refundCents: number,
): void {
  db.prepare(
    `INSERT INTO refund_requests (
       id, created_at, customer_id, order_id, message, message_sha256, decision,
       refund_amount_cents, summary, policy_ref, trace_json, overrides_json,
       eligible_item_ids_json, blocked_items_json, response_text, injection_json,
       ai_mode, llm_called, timings_json
     ) VALUES (?, '2026-01-01T00:00:00.000Z', 'CUST-LEGACY', 'ORD-LEGACY', 'msg', 'hash', ?,
       ?, 'summary', 'R-01', '{}', '[]', '[]', '[]', 'reply', '{}', 'fake', 0, '{}')`,
  ).run(id, decision, refundCents);
}

/**
 * The refunds table as it looked before the release timestamp existed.
 *
 * Found for real, not theorised: a database already at version 3 from a build
 * that predates the column kept the drifted table, because `CREATE TABLE IF NOT
 * EXISTS` is satisfied by a table that is merely present. Every approval then
 * failed with a bare SQLITE_ERROR naming a column the code believed was there,
 * while the test suite stayed green - it builds a fresh database every time.
 */
function driftedRefundsDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE refund_requests (id TEXT PRIMARY KEY);
    CREATE TABLE customers (id TEXT PRIMARY KEY);
    CREATE TABLE orders (id TEXT PRIMARY KEY);
    CREATE TABLE refunds (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      settled_at TEXT,
      release_reason TEXT
    );
  `);
  db.pragma('user_version = 3');
  return db;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

describe('migrations', () => {
  it('repairs a refunds table that drifted after it was created', () => {
    const db = driftedRefundsDatabase();
    expect(columnsOf(db, 'refunds')).not.toContain('released_at');

    const reached = migrate(db);

    // Same version number, missing column: `IF NOT EXISTS` cannot fix that, and
    // the code that writes the column cannot work until something does.
    expect(reached).toBe(LATEST_VERSION);
    expect(columnsOf(db, 'refunds')).toContain('released_at');
    db.close();
  });

  it('leaves an intact refunds table exactly as it found it', () => {
    const fresh = openMemoryDatabase();
    const before = columnsOf(fresh, 'refunds');
    fresh.close();

    const db = openMemoryDatabase();
    migrate(db);
    expect(columnsOf(db, 'refunds')).toEqual(before);
    db.close();
  });

  it('brings a pre-existing database up to the current version', () => {
    const db = legacyDatabase();
    insertLegacyRequest(db, 'REQ-1', 'approved', 12900);
    expect(versionOf(db)).toBe(0);

    const reached = migrate(db);

    expect(reached).toBe(LATEST_VERSION);
    db.close();
  });

  it('keeps historical rows readable and gives them an eligible amount', () => {
    const db = legacyDatabase();
    insertLegacyRequest(db, 'REQ-1', 'approved', 12900);
    insertLegacyRequest(db, 'REQ-2', 'denied', 0);
    migrate(db);

    // The query the API actually runs. Before migration this is the statement
    // that threw SQLITE_ERROR in production.
    const rows = db
      .prepare('SELECT id, decision, refund_amount_cents, eligible_amount_cents FROM refund_requests ORDER BY id')
      .all() as { id: string; eligible_amount_cents: number | null }[];

    expect(rows.map((r) => r.id)).toEqual(['REQ-1', 'REQ-2']);
    expect(rows.map((r) => r.eligible_amount_cents)).toEqual([12900, 0]);
    db.close();
  });

  it('leaves no null behind, because the column is NOT NULL', () => {
    const db = legacyDatabase();
    insertLegacyRequest(db, 'REQ-1', 'approved', 500);
    migrate(db);

    const info = db.prepare('PRAGMA table_info(refund_requests)').all() as {
      name: string;
      notnull: number;
    }[];
    const column = info.find((c) => c.name === 'eligible_amount_cents');

    expect(column).toBeDefined();
    // SQLite cannot add a NOT NULL column to a populated table, so the column
    // stays nullable and the invariant is enforced by the migration's own check
    // instead. This assertion documents that honestly.
    expect(column?.notnull).toBe(0);
    const nulls = db
      .prepare('SELECT COUNT(*) AS n FROM refund_requests WHERE eligible_amount_cents IS NULL')
      .get() as { n: number };
    expect(nulls.n).toBe(0);
    db.close();
  });

  /**
   * A database at version 16: `chat_closures` present, carrying the CHECK that
   * named only the base policy's two outcomes.
   *
   * Written by hand rather than reached by migrating, because the failure this
   * guards against is precisely a *rebuild* losing something: closure rows a
   * deployment already has must survive the table being replaced, the replacement
   * must accept the outcomes the discretion layer produces, and the
   * one-closure-per-thread index must come back - because SQLite cannot alter a
   * CHECK in place and a rebuild silently drops every index on the old table.
   */
  function version16Closures(): { db: Database.Database; customerId: string; requestId: string } {
    const db = openMemoryDatabase();
    seedDatabase(db, new Date('2026-03-14T12:00:00.000Z'));
    const customer = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get() as { id: string };
    const requestId = 'REQ-MIGRATION';
    insertRequest(db, {
      id: requestId,
      createdAt: '2026-01-01T00:00:00.000Z',
      customerId: customer.id,
      customerName: 'Migration Probe',
      orderId: null,
      message: 'probe',
      messageSha256: '0'.repeat(64),
      messageFingerprint: '0'.repeat(64),
      decision: 'denied',
      refundAmountCents: 0,
      eligibleAmountCents: 0,
      summary: 'probe',
      policyRef: 'REFUND_POLICY.md §3.2',
      traceJson: '[]',
      overridesJson: '[]',
      eligibleItemIdsJson: '[]',
      blockedItemsJson: '[]',
      responseText: 'probe',
      extractionJson: null,
      groundingJson: null,
      injectionJson: '{"detected":false,"signals":[],"obfuscationNoted":false}',
      aiMode: 'fake',
      llmCalled: false,
      timingsJson: '[]',
      scenarioId: null,
    });

    // Swap the current table for the shape version 16 had, keeping the existing
    // closure row, so the migration has something real to migrate.
    db.exec(`
      CREATE TABLE chat_closures_v16 (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        order_id    TEXT,
        request_id  TEXT NOT NULL REFERENCES refund_requests(id),
        closed_at   TEXT NOT NULL,
        closed_by   TEXT NOT NULL,
        final_state TEXT NOT NULL CHECK (final_state IN ('approved', 'denied'))
      );
      INSERT INTO chat_closures_v16
        SELECT 'CLOSE-LEGACY', '${customer.id}', NULL, '${requestId}',
               '2026-01-01T00:00:00.000Z', 'agent@example.com', 'approved';
      DROP TABLE chat_closures;
      ALTER TABLE chat_closures_v16 RENAME TO chat_closures;
    `);
    db.pragma('user_version = 16');
    return { db, customerId: customer.id, requestId };
  }

  /** A closure on its own order, so it is a different thread from the legacy row. */
  function insertClosure(
    db: Database.Database,
    values: { customerId: string; requestId: string; id: string; finalState: string },
  ): void {
    const order = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO chat_closures
         (id, customer_id, order_id, request_id, closed_at, closed_by, final_state)
       VALUES (?, ?, ?, ?, '2026-01-02T00:00:00.000Z', 'agent@example.com', ?)`,
    ).run(values.id, values.customerId, order.id, values.requestId, values.finalState);
  }

  it('widens the chat-closure CHECK without losing an existing closure', () => {
    const { db, customerId, requestId } = version16Closures();

    // The old constraint refuses the outcome an exchange produces, which is what
    // forced the writer to record it as a denial.
    expect(() => insertClosure(db, { customerId, requestId, id: 'CLOSE-X', finalState: 'exchange' })).toThrow(
      /CHECK constraint failed/,
    );

    const reached = migrate(db);

    expect(reached).toBe(LATEST_VERSION);
    const kept = db.prepare('SELECT final_state FROM chat_closures WHERE id = ?').get('CLOSE-LEGACY') as {
      final_state: string;
    };
    expect(kept.final_state).toBe('approved');
    expect(() => insertClosure(db, { customerId, requestId, id: 'CLOSE-X', finalState: 'exchange' })).not.toThrow();
    db.close();
  });

  it('keeps the one-closure-per-thread index after rebuilding the table', () => {
    const { db, customerId, requestId } = version16Closures();
    migrate(db);

    // A rebuild drops the index along with the old table, and the constraint it
    // enforced - one closure per conversation - is the thing that stops a closed
    // thread being closed twice with a different decision.
    insertClosure(db, { customerId, requestId, id: 'CLOSE-FIRST', finalState: 'approved' });

    // A second closure for the same (customer, order) thread, which is what the
    // index exists to refuse.
    const order = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get() as { id: string };
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_closures
             (id, customer_id, order_id, request_id, closed_at, closed_by, final_state)
           VALUES ('CLOSE-DUP', ?, ?, ?, '2026-01-03T00:00:00.000Z', 'agent@example.com', 'denied')`,
        )
        .run(customerId, order.id, requestId),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('is idempotent when replayed', () => {
    const db = legacyDatabase();
    insertLegacyRequest(db, 'REQ-1', 'approved', 900);
    migrate(db);
    migrate(db);
    migrate(db);

    expect(versionOf(db)).toBe(LATEST_VERSION);
    db.close();
  });

  it('does nothing on a database that is already current', () => {
    const db = openMemoryDatabase();
    const messages: string[] = [];

    migrate(db, (message) => messages.push(message));

    expect(messages).toEqual([]);
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('records a version a fresh database is already at', () => {
    const db = openMemoryDatabase();
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('creates a missing directory and records the version on a real file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'refund-migration-'));
    // A nested path that does not exist yet, because the first run of a fresh
    // deployment is exactly when that directory is missing.
    const file = join(dir, 'nested', 'refund.sqlite');

    try {
      const db = openDatabase(file);
      expect(versionOf(db)).toBe(SCHEMA_VERSION);

      db.prepare(
        `INSERT INTO refund_requests (
           id, created_at, customer_id, order_id, message, message_sha256, decision,
           refund_amount_cents, eligible_amount_cents, summary, policy_ref, trace_json,
           overrides_json, eligible_item_ids_json, blocked_items_json, response_text,
           injection_json, ai_mode, llm_called, timings_json
         ) VALUES ('REQ-NEW', '2026-01-01T00:00:00.000Z', 'C', 'O', 'm', 'h', 'approved',
           4200, 4200, 's', 'R-01', '{}', '[]', '[]', '[]', 'r', '{}', 'fake', 0, '{}')`,
      ).run();

      const row = db
        .prepare('SELECT refund_amount_cents, eligible_amount_cents FROM refund_requests')
        .get() as { refund_amount_cents: number; eligible_amount_cents: number };
      expect(row).toEqual({ refund_amount_cents: 4200, eligible_amount_cents: 4200 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function versionOf(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}
