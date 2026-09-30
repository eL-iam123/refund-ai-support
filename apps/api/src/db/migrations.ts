import { createHash } from 'node:crypto';
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

/**
 * True when `table` already has `column`, so a step can be replayed safely.
 *
 * `PRAGMA table_info` returns no rows for a table that does not exist, so this
 * reports false for a missing table and a missing column alike. A migration
 * that checks only this would go on to `ALTER TABLE` a table that was never
 * created - which turns a database that predates the feature into a database
 * that cannot start. Check `hasTable` first.
 */
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
  {
    version: 6,
    name: 'returns workflow',
    up: (db) => {
      // Physical goods coming back. Deliberately separate from the refund
      // tables: a return moves a box, a refund moves money, and the two are
      // neither the same event nor guaranteed to happen. Somebody can return
      // something with no intention of being repaid, and can be refused a refund
      // for a reason that has nothing to do with the parcel.
      db.exec(`
        CREATE TABLE IF NOT EXISTS returns (
          id              TEXT PRIMARY KEY,
          -- Nullable, and unique when present. A customer can send goods back
          -- without ever having asked for money - a gift return, an exchange, a
          -- "this is fine, I just do not want it" - so a return cannot require a
          -- refund request to exist first. Where one does exist it is recorded,
          -- because that is the request the restock and any refund hang off.
          -- SQLite treats NULLs as distinct in a unique index, so "at most one
          -- return per request" holds without also forcing a request onto every
          -- return.
          request_id      TEXT REFERENCES refund_requests(id) ON DELETE CASCADE,
          order_id        TEXT NOT NULL REFERENCES orders(id),
          customer_id     TEXT NOT NULL REFERENCES customers(id),
          status          TEXT NOT NULL CHECK (
                            status IN ('return_requested', 'return_label_generated', 'return_shipped', 'return_received', 'return_processed', 'return_denied')
                          ),
          reason          TEXT NOT NULL,
          tracking_number TEXT,
          carrier         TEXT,
          label_url       TEXT,
          shipped_at      TEXT,
          received_at     TEXT,
          processed_at    TEXT,
          denied_at       TEXT,
          denied_reason   TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_returns_order ON returns(order_id);
        CREATE INDEX IF NOT EXISTS idx_returns_customer ON returns(customer_id);
        CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
        -- The idempotency key for "one return per refund request". A partial
        -- index, because the guarantee is only meaningful where there is a
        -- request to be unique against.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_request ON returns(request_id)
          WHERE request_id IS NOT NULL;
      `);

      // The lines actually in the box. Name and price are snapshotted from the
      // order at the moment the return is opened, so the return still reads
      // correctly if the catalogue is renamed or repriced later.
      db.exec(`
        CREATE TABLE IF NOT EXISTS return_items (
          id            TEXT PRIMARY KEY,
          return_id     TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
          item_id       TEXT NOT NULL REFERENCES order_items(id),
          name          TEXT NOT NULL,
          quantity      INTEGER NOT NULL CHECK (quantity > 0),
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
          received_quantity INTEGER NOT NULL DEFAULT 0,
          received_condition TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
        CREATE INDEX IF NOT EXISTS idx_return_items_item ON return_items(item_id);
      `);
    },
  },
  {
    version: 7,
    name: 'order_items.product_id',
    up: (db) => {
      // Which product each purchased line was. Added so restocking a return is
      // a join rather than a human naming an id: the only reachable product is
      // the one on the order, so stock cannot be credited to something nobody
      // sent back.
      //
      // Backfilled by name where it is unambiguous. Name is not identity - two
      // products can share one - so an ambiguous or unrecognised line is left
      // NULL rather than guessed at. `processReturn` refuses to restock a NULL
      // one and says so, which is the honest outcome: the warehouse restocks that
      // line by hand instead of the database inventing a mapping.
      // The table may not exist at all: a database created before the shop
      // existed has `refund_requests` and `audit_events` and nothing else, and
      // `PRAGMA table_info` on a missing table returns no rows - so the column
      // check alone would fall through to an `ALTER TABLE` that cannot run.
      if (!hasTable(db, 'order_items') || hasColumn(db, 'order_items', 'product_id')) {
        return;
      }
      db.exec('ALTER TABLE order_items ADD COLUMN product_id TEXT REFERENCES products(id)');

      const candidates = db
        .prepare('SELECT id, name FROM products GROUP BY name HAVING COUNT(*) = 1')
        .all() as readonly { id: string; name: string }[];
      const update = db.prepare('UPDATE order_items SET product_id = ? WHERE name = ?');
      for (const product of candidates) {
        update.run(product.id, product.name);
      }
    },
  },
  {
    version: 8,
    name: 'refund_requests.message_fingerprint',
    up: (db) => {
      // A normalised hash of the message, used to recognise a repeat report.
      //
      // Separate from `message_sha256`, which hashes the message byte for byte
      // as part of the tamper-evident record. Reusing it here would make the
      // duplicate check exact-match only, so a customer who retypes the same
      // complaint - the single most common way this happens - would not be
      // recognised as having already asked. The two hashes are answering
      // different questions and must not be collapsed into one.
      //
      // Backfilled from the message, so existing history is covered by the check
      // the moment the migration runs rather than only for new requests.
      if (!hasTable(db, 'refund_requests') || hasColumn(db, 'refund_requests', 'message_fingerprint')) {
        return;
      }
      db.exec('ALTER TABLE refund_requests ADD COLUMN message_fingerprint TEXT');

      // Older databases predate the stored message. A row with no text cannot be
      // fingerprinted, and a NULL fingerprint is not a match, so it is simply
      // never treated as a duplicate - which is the right answer, since the
      // alternative would be inventing a hash over an empty string and matching
      // every message-less row to every other.
      if (!hasColumn(db, 'refund_requests', 'message')) {
        return;
      }

      const rows = db
        .prepare('SELECT id, message FROM refund_requests WHERE message_fingerprint IS NULL')
        .all() as readonly { id: string; message: string }[];
      const update = db.prepare('UPDATE refund_requests SET message_fingerprint = ? WHERE id = ?');
      for (const row of rows) {
        update.run(fingerprintOf(row.message), row.id);
      }

      // Not UNIQUE, and not indexed here alone: a customer may legitimately
      // make the same claim twice - after a denial, or after a new fact - and
      // the policy decides whether the second one stands. The index serves the
      // lookup by (customer, fingerprint, time) and leaves the ruling to R-15.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_refund_requests_fingerprint ON refund_requests (customer_id, message_fingerprint, created_at)',
      );
    },
  },
  {
    version: 9,
    name: 'customer_updates',
    up: (db) => {
      // What the customer is told after a person acts on their request.
      //
      // Not a column on `refund_requests`, because one request can be acted on
      // more than once: approved, then settled, then queried about. Each of those
      // is a separate thing the customer needs to hear, in the order it happened.
      // A single "last update" column would keep the newest and lose the rest,
      // which is exactly the history someone is most likely to want.
      //
      // The body is written once, at the moment of the action, and never
      // recomputed. Read-side composition would mean the words a customer was
      // shown in March depend on code written in September, and an audit that
      // cannot reproduce the message it sent is not an audit.
      db.exec(`
        CREATE TABLE IF NOT EXISTS customer_updates (
          id           TEXT PRIMARY KEY,
          created_at   TEXT NOT NULL,
          customer_id  TEXT NOT NULL,
          order_id     TEXT,
          request_id   TEXT NOT NULL,
          kind         TEXT NOT NULL,
          body         TEXT NOT NULL
        );
      `);
      // The thread read is by customer and order; the write is by request, so
      // both get an index rather than one and a scan.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_customer_updates_thread ON customer_updates (customer_id, order_id, created_at)',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_customer_updates_request ON customer_updates (request_id)');
    },
  },
  {
    version: 10,
    name: 'shop_dialogue',
    up: (db) => {
      // The clarify-then-decide conversation between the assistant and a customer.
      //
      // An assistant question is not a decision, so it has no row in
      // `refund_requests` - nothing was resolved, nothing was refused. But it is
      // still the customer's history: if they answer "the blue one" in a later
      // message, the model has to be able to see that they were asked which item,
      // and the customer has to be able to see that they asked. Dropping those
      // turns would produce an assistant that asks the same question twice and an
      // audit that cannot say how a decision came to be reached.
      //
      // `customer_message` is the customer's own words; `assistant_question` is
      // the question the model was permitted to publish, verbatim. Two columns
      // rather than one interleaved table, because a question never happens
      // without the message it answers - this is not a general message log, it is
      // the record of a question-and-answer, and a row must always have both.
      db.exec(`
        CREATE TABLE IF NOT EXISTS shop_dialogue (
          id                TEXT PRIMARY KEY,
          created_at        TEXT NOT NULL,
          customer_id       TEXT NOT NULL,
          order_id          TEXT,
          customer_message  TEXT NOT NULL,
          assistant_question TEXT NOT NULL
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_shop_dialogue_thread ON shop_dialogue (customer_id, order_id, created_at)',
      );
    },
  },
  {
    version: 11,
    name: 'live human takeover',
    up: (db) => {
      // A customer thread handed to a person.
      //
      // The AI assistant and a customer can be talking when the assistant decides
      // it cannot help - or when a staff member decides it should not - and the
      // customer keeps typing in the same box. `handoffs` is the record of that:
      // which customer, which thread, which staff member took it, and whether it
      // is still live. `ended_at` is null while a person is attached, which the
      // partial unique index turns into "at most one live takeover per customer":
      // two agents chatting into the same customer's box would be a mess with no
      // record at all.
      //
      // `order_id` is nullable because a takeover can start mid-clarify, before
      // any order has been identified - the thread is per customer either way.
      //
      // The messages exchanged while a person is attached live in a separate
      // table rather than in `shop_dialogue`, which is a question-and-answer
      // record with exactly two columns and does not fit a free conversation.
      // `sender` says whose words they are: the customer's messages are routed
      // here too, because the AI pipeline is deliberately *not* running while a
      // person is on the line.
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoffs (
          id          TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id),
          order_id    TEXT,
          agent_id    TEXT NOT NULL,
          started_at  TEXT NOT NULL,
          ended_at    TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_one_active
          ON handoffs(customer_id) WHERE ended_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_handoffs_customer ON handoffs(customer_id, started_at);

        CREATE TABLE IF NOT EXISTS agent_messages (
          id          TEXT PRIMARY KEY,
          created_at  TEXT NOT NULL,
          handoff_id  TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
          sender      TEXT NOT NULL CHECK (sender IN ('agent', 'customer')),
          body        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_messages_handoff ON agent_messages (handoff_id, created_at);
      `);
    },
  },
  {
    version: 12,
    name: 'appeals and chat media',
    up: (db) => {
      // A customer asking a person to look again at a refused request.
      //
      // Every denial the policy produces is deliberate - a hard rule refused the
      // money - so an appeal is not a triage gate. It is the customer explicitly
      // disagreeing, which is exactly the signal a person needs before they spend
      // time re-reading a decided case. `decided_at` being null is what makes the
      // appeal live, and the partial unique index turns "the customer asked again"
      // into a state rather than a queue of repeat clicks: at most one appeal can
      // be sitting with a person per request. Deciding an appeal is a hand-off to
      // the takeover machinery, not a column flip here - the person talks it out
      // in `agent_messages` and then overrides the request, which closes the
      // appeal (`closeAppealsForRequest` in `applyHumanOverride`).
      //
      // The media columns on `agent_messages` are how a photo travels in a
      // takeover: a person's reply, or the customer's own picture, with the file
      // on disk and the route to it on the row. `body` stays NOT NULL - a photo
      // message may carry a caption or an empty string, never absence.
      db.exec(`
        CREATE TABLE IF NOT EXISTS appeals (
          id          TEXT PRIMARY KEY,
          created_at  TEXT NOT NULL,
          customer_id TEXT NOT NULL REFERENCES customers(id),
          request_id  TEXT NOT NULL REFERENCES refund_requests(id),
          reason      TEXT NOT NULL,
          decided_at  TEXT,
          decided_by  TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_appeals_one_open
          ON appeals(request_id) WHERE decided_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_appeals_customer ON appeals (customer_id, created_at);

        ALTER TABLE agent_messages ADD COLUMN media_path TEXT;
        ALTER TABLE agent_messages ADD COLUMN media_type TEXT;
        ALTER TABLE agent_messages ADD COLUMN media_bytes INTEGER;
      `);
    },
  },
];

/**
 * The duplicate-detection fingerprint of a message.
 *
 * Case-folded, punctuation removed, whitespace collapsed, digits kept. A
 * difference in capitalisation, an extra space, or a stray full stop is not a
 * different complaint; a different order number or amount is. Digits stay for
 * that reason - the numbers in a message are usually the part that makes it
 * about a specific thing.
 *
 * Duplicated here rather than imported so the migration is a frozen artifact:
 * a migration that imported today's helper would silently re-interpret history
 * if that helper ever changed. The rule is the fingerprint as it was defined
 * when the column was introduced.
 */
function fingerprintOf(message: string): string {
  return createHash('sha256')
    .update(
      message
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim(),
      'utf8',
    )
    .digest('hex');
}

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
 *
 * The list is applied in the order it is written, and `user_version` is a plain
 * counter, so a step inserted above a version that has already been applied is
 * silently skipped forever. That is worth a check that can actually fail: the
 * original guard compared each version against `LATEST_VERSION`, which is the
 * maximum of the same list, so it was true by construction and never rejected
 * anything. Comparing against the previous entry catches a step written out of
 * order, which is how the returns step once ended up ahead of the audit chain it
 * depended on.
 */
export function migrate(db: Db, log?: (message: string) => void): number {
  const from = currentVersion(db);
  assertOrdered();
  const pending = MIGRATIONS.filter((m) => m.version > from);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    log?.(`migrated to ${migration.version} (${migration.name})`);
  }

  return currentVersion(db);
}

/**
 * Fails the process on a list that would apply out of order, on a duplicate
 * version, or on a gap. Gaps are refused because a missing number is nearly
 * always a botched edit rather than a deliberate skip, and a deliberate skip
 * should be spelled out in a comment instead of a hole.
 */
function assertOrdered(): void {
  const seen = new Set<number>();
  let previous = 0;
  for (const migration of MIGRATIONS) {
    if (seen.has(migration.version)) {
      throw new Error(`migration ${migration.version} ("${migration.name}") is declared twice`);
    }
    if (migration.version !== previous + 1) {
      throw new Error(
        `migration ${migration.version} ("${migration.name}") does not follow ${previous}; ` +
          'steps are applied in the order written, so a gap or a reordering will be skipped forever',
      );
    }
    seen.add(migration.version);
    previous = migration.version;
  }
}
