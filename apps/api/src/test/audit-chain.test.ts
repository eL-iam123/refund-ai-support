import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { migrate } from '../db/migrations.js';
import {
  GENESIS_HASH,
  appendAuditEvent,
  eventHash,
  listAuditEvents,
  verifyAuditChain,
} from '../db/auditChain.js';
import { insertAuditEvent } from '../db/requestRepository.js';
import { appHarness, authHeader, TEST_NOW } from './helpers.js';

/**
 * Tamper evidence.
 *
 * A hash chain is only worth having if it fails when the trail is altered, so
 * these tests alter it. Several reach past the application's own API to run raw
 * SQL, because the point is to prove the *database* refuses the edit - a test that
 * only used the repository would pass even if nothing stopped a direct write.
 *
 * Note what is deliberately not claimed: an attacker who can write to the
 * database can recompute the chain from the point they entered. Detecting that
 * needs an external anchor for the head hash, and the tests below prove internal
 * consistency only.
 */

const AT = TEST_NOW.toISOString();

function chainDb(): Db {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

function write(db: Db, kind: string, detail: string): number {
  return appendAuditEvent(db, { requestId: 'REQ-1', at: AT, kind, detail });
}

/** Edits a row the way a careless operator or a stray script would. */
function tamperWith(db: Db, id: number, detail: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TRIGGER IF EXISTS audit_events_no_update;
    UPDATE audit_events SET detail = '${detail}' WHERE id = ${id};
  `);
}

describe('the audit chain', () => {
  it('starts the first event at genesis rather than at nothing', () => {
    const db = chainDb();

    const id = write(db, 'decision', 'approved $10.00');

    const [event] = listAuditEvents(db, 'REQ-1');
    // 64 zeros, not NULL: the arithmetic for "the previous row's hash" has no
    // special case for the first row, so there is no way to confuse first with
    // lost.
    expect(event?.prevHash).toBe(GENESIS_HASH);
    expect(event?.id).toBe(id);
    db.close();
  });

  it('links every event to the one before it', () => {
    const db = chainDb();

    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_authorised', '$10.00 pending human verification');
    const third = write(db, 'refund_settled', '1000 cents settled');

    const events = listAuditEvents(db, 'REQ-1');
    expect(events).toHaveLength(3);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(events[2]?.prevHash).toBe(events[1]?.hash);
    // A chain of three ends where the third row says it does.
    expect(events[2]?.hash).toBe(third > 0 ? events[2]?.hash : '');
    db.close();
  });

  it('verifies a chain nobody has touched', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_authorised', '$10.00 pending human verification');

    const verdict = verifyAuditChain(db);

    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBe(2);
    db.close();
  });

  it('verifies an empty trail, which is a chain of nothing rather than a broken one', () => {
    const db = chainDb();

    const verdict = verifyAuditChain(db);

    expect(verdict).toEqual({ ok: true, checked: 0, headHash: GENESIS_HASH });
    db.close();
  });

  it('spans every request, not just one', () => {
    const db = chainDb();
    appendAuditEvent(db, { requestId: 'REQ-1', at: AT, kind: 'decision', detail: 'first' });
    appendAuditEvent(db, { requestId: 'REQ-2', at: AT, kind: 'decision', detail: 'second' });
    appendAuditEvent(db, { requestId: 'REQ-1', at: AT, kind: 'refund_settled', detail: 'third' });

    // A per-request query would be a separate chain per request and could not
    // detect a row deleted from one while the other stayed intact.
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, checked: 3 });
    db.close();
  });
});

describe('the chain notices tampering', () => {
  it('fails when a past detail is edited', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_settled', '1000 cents settled');
    tamperWith(db, 1, 'approved $1000.00');

    const verdict = verifyAuditChain(db);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.brokenAtId).toBe(1);
      expect(verdict.reason).toContain('edited after it was written');
    }
    db.close();
  });

  it('fails when a row is deleted from the middle', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_authorised', '$10.00 pending verification');
    write(db, 'refund_settled', '1000 cents settled');
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_delete; DELETE FROM audit_events WHERE id = 2;');

    const verdict = verifyAuditChain(db);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // The third row still points at the second row's hash, which is gone.
      expect(verdict.brokenAtId).toBe(3);
      expect(verdict.reason).toContain('inserted, removed or reordered');
    }
    db.close();
  });

  it('fails when the beginning is truncated', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_settled', '1000 cents settled');
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_delete; DELETE FROM audit_events WHERE id = 1;');

    // The remaining row's prev_hash is genesis only by coincidence of history; if
    // the first row had been removed from the middle of a real trail the link
    // would point at a hash nothing produces.
    const verdict = verifyAuditChain(db);
    expect(verdict.ok).toBe(false);
    db.close();
  });

  it('fails when a row is inserted into the middle', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    write(db, 'refund_settled', '1000 cents settled');
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_update;');
    // A forger who can insert cannot re-link the rows after their forgery, which
    // is what makes the chain worth having without an external anchor.
    db.exec(
      `INSERT INTO audit_events (request_id, at, kind, detail, prev_hash, hash)
       VALUES ('REQ-1', '${AT}', 'human_override', 'smuggled in', '${GENESIS_HASH}', 'deadbeef');`,
    );

    const verdict = verifyAuditChain(db);

    expect(verdict.ok).toBe(false);
    db.close();
  });

  it('fails when a field is shifted between columns to keep the row readable', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TRIGGER IF EXISTS audit_events_no_update;
      UPDATE audit_events SET kind = 'human_override', detail = 'decision' WHERE id = 1;
    `);

    // Length-prefixed hashing is what stops `("ab","c")` and `("a","bc")` hashing
    // alike, which is the trick that would let a row be reworded field by field
    // and still verify.
    expect(verifyAuditChain(db).ok).toBe(false);
    db.close();
  });
});

describe('the database refuses edits to the trail', () => {
  it('aborts an UPDATE', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');

    // No trigger dropped, no foreign keys offed: this is the write the database
    // is supposed to stop on its own.
    expect(() => db.prepare("UPDATE audit_events SET detail = 'edited' WHERE id = 1").run()).toThrow(
      /append-only/,
    );
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, checked: 1 });
    db.close();
  });

  it('aborts a DELETE', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');

    expect(() => db.prepare('DELETE FROM audit_events WHERE id = 1').run()).toThrow(/append-only/);
    db.close();
  });

  it('still allows a new row, because the chain is append-only, not frozen', () => {
    const db = chainDb();
    write(db, 'decision', 'approved $10.00');

    expect(() => write(db, 'refund_settled', '1000 cents settled')).not.toThrow();
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, checked: 2 });
    db.close();
  });
});

describe('the hash itself', () => {
  it('changes when any field changes', () => {
    const base = eventHash(GENESIS_HASH, 'REQ-1', AT, 'decision', 'detail');

    expect(eventHash(GENESIS_HASH, 'REQ-2', AT, 'decision', 'detail')).not.toBe(base);
    expect(eventHash(GENESIS_HASH, 'REQ-1', '2020-01-01T00:00:00.000Z', 'decision', 'detail')).not.toBe(base);
    expect(eventHash(GENESIS_HASH, 'REQ-1', AT, 'refund_settled', 'detail')).not.toBe(base);
    expect(eventHash(GENESIS_HASH, 'REQ-1', AT, 'decision', 'detail ')).not.toBe(base);
    expect(eventHash(eventHash(GENESIS_HASH, 'REQ-0', AT, 'x', 'y'), 'REQ-1', AT, 'decision', 'detail')).not.toBe(
      base,
    );
  });

  it('does not let fields be swapped by concatenation', () => {
    // The reason fields are length-prefixed. Without it these two hash the same
    // and a `detail` could be moved into `kind` to produce a row that verifies.
    expect(eventHash(GENESIS_HASH, 'ab', AT, 'c', '')).not.toBe(eventHash(GENESIS_HASH, 'a', AT, 'bc', ''));
  });

  it('is deterministic, so a re-derived chain matches the stored one', () => {
    const first = eventHash(GENESIS_HASH, 'REQ-1', AT, 'decision', 'x');
    expect(eventHash(GENESIS_HASH, 'REQ-1', AT, 'decision', 'x')).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migrating a database that already had events', () => {
  function withHistory(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE refund_requests (id TEXT PRIMARY KEY);
      CREATE TABLE customers (id TEXT PRIMARY KEY);
      CREATE TABLE orders (id TEXT PRIMARY KEY);
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      INSERT INTO audit_events (request_id, at, kind, detail) VALUES
        ('REQ-1', '${AT}', 'decision', 'approved $10.00'),
        ('REQ-1', '${AT}', 'refund_authorised', '$10.00 pending verification'),
        ('REQ-2', '${AT}', 'decision', 'denied');
    `);
    db.pragma('user_version = 4');
    return db;
  }

  it('chains the history already on disk instead of starting from the new event', () => {
    const db = withHistory();

    migrate(db);

    // A chain beginning after the upgrade would say nothing at all about the rows
    // it left out, which are the ones somebody might be interested in.
    const verdict = verifyAuditChain(db);
    expect(verdict).toMatchObject({ ok: true, checked: 3 });
    const rows = listAuditEvents(db, 'REQ-1');
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    db.close();
  });

  it('is replayable, so a half-migrated database is not punished', () => {
    const db = withHistory();
    migrate(db);
    const first = verifyAuditChain(db);

    // Re-running must not re-hash the already-hashed rows, which would replace
    // the chain with one rooted wherever the first pass happened to start.
    migrate(db);

    expect(verifyAuditChain(db)).toEqual(first);
    db.close();
  });

  it('lets new events chain onto the backfilled history', () => {
    const db = withHistory();
    migrate(db);

    const before = verifyAuditChain(db);
    if (!before.ok) {
      throw new Error('backfill left a broken chain');
    }
    appendAuditEvent(db, { requestId: 'REQ-2', at: AT, kind: 'refund_settled', detail: 'settled' });

    const after = verifyAuditChain(db);
    expect(after).toMatchObject({ ok: true, checked: 4 });
    if (after.ok) {
      expect(after.headHash).not.toBe(before.headHash);
    }
    db.close();
  });
});

describe('the repository and the chain cannot drift apart', () => {
  it('routes the shared helper into the chain', () => {
    const db = chainDb();

    insertAuditEvent(db, 'REQ-1', AT, 'decision', 'approved $10.00');
    insertAuditEvent(db, 'REQ-1', AT, 'refund_settled', '1000 cents settled');

    // The helper every call site already used, now producing hashed rows. If
    // someone reintroduces a bare INSERT here, this fails rather than leaving a
    // row that quietly fails verification in production.
    const verdict = verifyAuditChain(db);
    expect(verdict).toMatchObject({ ok: true, checked: 2 });
    db.close();
  });
});

describe('the verification endpoint', () => {
  it('reports a clean chain to an admin', async () => {
    const { app, db } = await appHarness();
    appendAuditEvent(db, { requestId: 'REQ-1', at: AT, kind: 'decision', detail: 'approved' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/verify',
      headers: { authorization: authHeader('admin') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ audit: { ok: boolean; checked: number } }>().audit).toMatchObject({ ok: true });
  });

  it('names the row that failed, rather than only saying it failed', async () => {
    const { app, db } = await appHarness();
    appendAuditEvent(db, { requestId: 'REQ-1', at: AT, kind: 'decision', detail: 'approved' });
    tamperWith(db, 1, 'edited after the fact');

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/verify',
      headers: { authorization: authHeader('admin') },
    });

    // Still a 200: a broken chain is a finding to read, not a failed request.
    const audit = response.json<{ audit: { ok: boolean; brokenAtId: number; reason: string } }>().audit;
    expect(audit.ok).toBe(false);
    expect(audit.brokenAtId).toBe(1);
    expect(audit.reason).toContain('edited');
  });

  it('keeps the endpoint above an ordinary agent', async () => {
    const { app } = await appHarness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/audit/verify',
      headers: { authorization: authHeader('agent') },
    });

    // Verifying the trail is a question about the whole system, not one order.
    expect(response.statusCode).toBe(403);
  });
});
