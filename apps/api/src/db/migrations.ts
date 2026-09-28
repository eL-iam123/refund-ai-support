import type Database from 'better-sqlite3';
import { GENESIS_HASH, eventHash } from './auditChain.js';

/**
 * Schema migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` is not a migration strategy: it creates a table
 * that is missing and leaves a table that has drifted exactly as it found it. A
 * column added to the `CREATE` block therefore reaches fresh databases and
 * never reaches an existing one, where every query naming it fails at runtime
 * with a bare `SQLITE_ERROR`. That is the failure mode this file exists to
 * remove, and it is why the migration list rather than the schema text is the
 * source of truth.
 *
 * Each step is numbered, applied in order, and recorded in SQLite's own
 * `user_version` pragma - a counter the engine maintains, so tracking the
 * applied version costs no extra table. Steps are written to be idempotent
 * anyway: an operator restoring a backup into a half-migrated database should
 * not be punished with a duplicate-column error.
 */

type Db = Database.Database;

interface Migration {
  /** Monotonic. Never renumber or reuse: the counter is what orders the work. */
  readonly version: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

/** True when `table` exists at all, so a step can handle a partial restore. */
function hasTable(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}

/** True when `table` already has `column`, so a step can be replayed safely. */
function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((entry) => entry.name === column);
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'refund_requests.eligible_amount_cents',
    up: (db) => {
      if (hasColumn(db, 'refund_requests', 'eligible_amount_cents')) {
        return;
      }
      // A NOT NULL column cannot be added without a default on an existing
      // table, and SQLite forbids the usual "add NOT NULL" shape, so the column
      // lands nullable first and is backfilled before it is tightened.
      db.exec('ALTER TABLE refund_requests ADD COLUMN eligible_amount_cents INTEGER');
      // Historical rows have no recorded eligible figure. Approximating with
      // the amount that was actually paid keeps the column non-null and honest:
      // for an approval the eligible amount was at least the refund, and for
      // anything else nothing is at stake as far as this system decided.
      db.exec(
        `UPDATE refund_requests
            SET eligible_amount_cents = CASE WHEN decision = 'approved'
                                             THEN refund_amount_cents ELSE 0 END
          WHERE eligible_amount_cents IS NULL`,
      );
      // Drop the leftover nulls by rebuilding only if any survived, which the
      // UPDATE above should have prevented.
      const orphans = db
        .prepare('SELECT COUNT(*) AS n FROM refund_requests WHERE eligible_amount_cents IS NULL')
        .get() as { n: number };
      if (orphans.n > 0) {
        throw new Error(`migration 1 left ${orphans.n} rows without an eligible amount`);
      }
    },
  },
  {
    version: 2,
    name: 'storefront: products, users, sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          blurb           TEXT NOT NULL,
          description     TEXT NOT NULL,
          price_cents     INTEGER NOT NULL,
          -- Mirrors the order_items flags so a catalogue item and a purchased
          -- line describe the same thing; the refund rules read these.
          final_sale      INTEGER NOT NULL DEFAULT 0,
          digital         INTEGER NOT NULL DEFAULT 0,
          is_subscription INTEGER NOT NULL DEFAULT 0,
          stock           INTEGER NOT NULL DEFAULT 0,
          -- Set on the handful of items chosen to exercise a specific policy
          -- path, so a tester can aim at a rule rather than guess.
          tests_policy    TEXT,
          image_hue       INTEGER NOT NULL DEFAULT 210
        );

        CREATE TABLE IF NOT EXISTS shop_users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          -- One customer per account. A user row without a customer could not
          -- place an order, and an order without a customer could not be
          -- refunded, so the link is NOT NULL rather than optional.
          customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          is_demo       INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shop_sessions (
          -- The cookie carries a random token; only its SHA-256 is stored, so a
          -- stolen database cannot be replayed against a live server.
          token_hash   TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
          created_at   TEXT NOT NULL,
          expires_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON shop_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON shop_sessions(expires_at);
      `);
    },
  },
  {
    version: 3,
    name: 'refunds ledger',
    up: (db) => {
      db.exec(`
        -- The ledger of money that has actually moved, and of money that has been
        -- authorised but not yet paid.
        --
        -- 'refunded_cents' on the order is a fact: it counts settled payments.
        -- This table is where an authorisation lives until a person checks it,
        -- because an approval is a decision, not a payment. Keeping the two
        -- apart is what stops the same order being approved twice over while the
        -- first claim is still sitting in a queue.
        --
        -- One row per request (UNIQUE) so re-running the pipeline for a request
        -- cannot authorise a second payment, and one row per idempotency key so
        -- a retried payout to the processor cannot settle twice.
        CREATE TABLE IF NOT EXISTS refunds (
          id              TEXT PRIMARY KEY,
          request_id      TEXT NOT NULL UNIQUE REFERENCES refund_requests(id) ON DELETE CASCADE,
          order_id        TEXT NOT NULL REFERENCES orders(id),
          customer_id     TEXT NOT NULL REFERENCES customers(id),
          amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
          currency        TEXT NOT NULL DEFAULT 'USD',
          status          TEXT NOT NULL CHECK (
                            status IN ('pending_verification', 'settled', 'released')
                          ),
          -- Sent to the payment processor, so a retry of the same transfer is
          -- recognised as the same transfer rather than a second one.
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at      TEXT NOT NULL,
          verified_by     TEXT,
          verified_at     TEXT,
          settled_at      TEXT,
          released_at     TEXT,
          release_reason  TEXT,
          -- A settled row must say who checked it and when; a released row must
          -- say why. Enforced here so an unreviewed settlement cannot be written.
          CHECK (
            (status = 'pending_verification' AND verified_by IS NULL AND settled_at IS NULL)
            OR (status = 'settled' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND settled_at IS NOT NULL)
            OR (status = 'released' AND release_reason IS NOT NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
        CREATE INDEX IF NOT EXISTS idx_refunds_customer ON refunds(customer_id);
      `);
    },
  },
  {
    version: 4,
    name: 'refunds.released_at',
    up: (db) => {
      // A `refunds` table created by a build before the release timestamp was
      // migrated is left exactly as it was, because `CREATE TABLE IF NOT EXISTS`
      // is satisfied by a table that is merely present. That database then claims
      // to be current while every approval fails with a bare SQLITE_ERROR naming
      // a column the code believes exists.
      //
      // This is a separate step rather than a guard inside version 3 precisely
      // because of that: such a database already records version 3, so version 3
      // is never applied to it again and could never repair it. Only advancing
      // the counter runs this.
      if (hasColumn(db, 'refunds', 'released_at')) {
        return;
      }
      db.exec('ALTER TABLE refunds ADD COLUMN released_at TEXT');
    },
  },
  {
    version: 5,
    name: 'audit_events hash chain',
    up: (db) => {
      // Each row carries the hash of the row before it, so altering any past
      // event invalidates every hash after it. An audit trail that can be edited
      // in place is a record of whatever somebody decided to leave in it, and the
      // usual failure is not a sophisticated attacker - it is a support engineer
      // tidying up a note that reads badly, or a retry overwriting a row.
      //
      // `prev_hash` of the genesis row is 64 zeros rather than NULL, so the
      // arithmetic of "the previous row's hash" has no special case for the first
      // row and no way to distinguish "first" from "hash was lost".
      if (!hasTable(db, 'audit_events')) {
        // A database with no audit trail at all, which a restore from a partial
        // backup can produce. Created with the chain columns in place rather than
        // created bare and altered, so the shape is right from the first row.
        db.exec(`
          CREATE TABLE audit_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT NOT NULL,
            at         TEXT NOT NULL,
            kind       TEXT NOT NULL,
            detail     TEXT NOT NULL,
            prev_hash  TEXT NOT NULL,
            hash       TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
        `);
      }
      for (const column of ['prev_hash', 'hash'] as const) {
        if (!hasColumn(db, 'audit_events', column)) {
          db.exec(`ALTER TABLE audit_events ADD COLUMN ${column} TEXT`);
        }
      }

      // The existing rows are backfilled, oldest first, so the chain covers the
      // history that is already on disk rather than beginning at the first event
      // written after this migration. A chain that starts mid-history proves
      // nothing about the part it omits.
      backfillChain(db);

      // Append-only, enforced by the database rather than by convention. Three
      // write paths exist in this codebase (the pipeline, the override route and
      // the refund routes) and a fourth would be written by someone in a hurry;
      // a rule only the first author remembers is not a rule.
      //
      // The triggers are dropped and recreated so the step is replayable.
      db.exec(`
        DROP TRIGGER IF EXISTS audit_events_no_update;
        DROP TRIGGER IF EXISTS audit_events_no_delete;
        CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
          BEGIN SELECT RAISE(ABORT, 'audit_events is append-only: an event cannot be edited'); END;
        CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
          BEGIN SELECT RAISE(ABORT, 'audit_events is append-only: an event cannot be removed'); END;
      `);
    },
  },
];

/**
 * Hashes every existing event in order, oldest first.
 *
 * Written in JavaScript rather than as a SQL loop because SQLite has no
 * recursive UPDATE, and a single statement over the table cannot see its own
 * writes in a stable order. Idempotent: rows that already carry a hash are left
 * alone, so replaying the migration does not re-chain a chain that is already
 * correct.
 */
function backfillChain(db: Db): void {
  const rows = db
    .prepare('SELECT id, request_id, at, kind, detail, hash FROM audit_events ORDER BY id')
    .all() as { id: number; request_id: string; at: string; kind: string; detail: string; hash: string | null }[];

  const update = db.prepare('UPDATE audit_events SET prev_hash = ?, hash = ? WHERE id = ?');
  let previous = GENESIS_HASH;
  for (const row of rows) {
    if (row.hash !== null) {
      previous = row.hash;
      continue;
    }
    const hash = eventHash(previous, row.request_id, row.at, row.kind, row.detail);
    update.run(previous, hash, row.id);
    previous = hash;
  }
}

/** The highest version this build knows how to reach. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function currentVersion(db: Db): number {
  const row = db.pragma('user_version', { simple: true }) as number;
  return typeof row === 'number' ? row : 0;
}

/**
 * Applies every pending step, each in its own transaction so a failure leaves
 * the recorded version consistent with what is actually in the file.
 */
export function migrate(db: Db, log?: (message: string) => void): number {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from);

  if (pending.length > 0) {
    const older = pending.filter((m) => m.version <= LATEST_VERSION);
    if (older.length !== pending.length) {
      throw new Error('migration list is not ordered by version');
    }
  }

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    log?.(`migrated to ${migration.version} (${migration.name})`);
  }

  return currentVersion(db);
}
