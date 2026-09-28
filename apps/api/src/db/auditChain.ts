import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * The audit chain.
 *
 * Every event carries the hash of the event before it. Change any past row and
 * every hash after it stops matching, so a tampered trail fails verification
 * rather than quietly telling a different story.
 *
 * The two things that make this worth having are both boring on purpose:
 *
 * - **One insert path.** Three routes write events, and a fourth gets written by
 *   whoever is in a hurry. If computing the hash were optional, the first event
 *   written without it would silently break the chain for everything after it.
 *   `appendAuditEvent` is the only way in, and `insertAuditEvent` in
 *   requestRepository now delegates to it rather than running its own INSERT.
 * - **The database refuses edits.** Triggers abort any UPDATE or DELETE, so
 *   append-only is enforced by something that was not written by the same person
 *   who would want to break it.
 *
 * What this does *not* do is stop an attacker who can write to the database from
 * recomputing the whole chain from the point they entered. That needs an external
 * anchor - publishing the head hash somewhere the database cannot reach - and is
 * deliberately out of scope here. A chain proves internal consistency, which
 * catches the realistic cases: a stray UPDATE, a restore from a partial backup,
 * a support engineer tidying a note.
 */

type Db = Database.Database;

/** The `prev_hash` of the first event: 64 zeros, not NULL. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEvent {
  readonly id: number;
  readonly requestId: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
  readonly prevHash: string;
  readonly hash: string;
}

interface AuditRow {
  readonly id: number;
  readonly request_id: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
  readonly prev_hash: string | null;
  readonly hash: string | null;
}

/**
 * One event's hash, over the previous hash and every field of this event.
 *
 * The fields are length-prefixed rather than joined with a separator. Without
 * that, `("ab", "c")` and `("a", "bc")` hash the same and a detail string could be
 * shifted between fields to forge a row that verifies. Field order is part of the
 * definition and must never be rearranged without a new chain.
 */
export function eventHash(
  prevHash: string,
  requestId: string,
  at: string,
  kind: string,
  detail: string,
): string {
  const parts = [prevHash, requestId, at, kind, detail].map(
    (field) => `${Buffer.byteLength(field, 'utf8')}:${field}`,
  );
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

function hydrate(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    at: row.at,
    kind: row.kind,
    detail: row.detail,
    prevHash: row.prev_hash ?? '',
    hash: row.hash ?? '',
  };
}

export interface AppendInput {
  readonly requestId: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

/**
 * Appends one event, chained to the current head.
 *
 * The caller may be inside a transaction (the pipeline wraps its decision and
 * reservation in one). Reading the head and writing the successor are therefore
 * two statements in whatever transaction the caller already holds, and a second
 * writer cannot interleave between them: SQLite serialises writers, so either
 * this transaction is the only one in flight or it waits.
 */
export function appendAuditEvent(db: Db, event: AppendInput): number {
  const head = db
    .prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1')
    .get() as { hash: string | null } | undefined;
  const previous = head?.hash ?? GENESIS_HASH;
  const hash = eventHash(previous, event.requestId, event.at, event.kind, event.detail);

  const result = db
    .prepare(
      'INSERT INTO audit_events (request_id, at, kind, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(event.requestId, event.at, event.kind, event.detail, previous, hash);
  return Number(result.lastInsertRowid);
}

export function listAuditEvents(db: Db, requestId: string): AuditEvent[] {
  const rows = db
    .prepare('SELECT id, request_id, at, kind, detail, prev_hash, hash FROM audit_events WHERE request_id = ? ORDER BY id')
    .all(requestId) as AuditRow[];
  return rows.map(hydrate);
}

export type ChainVerdict =
  | { readonly ok: true; readonly checked: number; readonly headHash: string }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly brokenAtId: number;
      readonly reason: string;
    };

/**
 * Walks the whole chain and reports the first row that does not hold up.
 *
 * Verifies three things per row, because each catches a different accident:
 * `prev_hash` links it to its predecessor (an inserted or deleted row), `hash`
 * matches the row's own content (an edited row), and the first row links to
 * genesis (a truncated beginning).
 */
export function verifyAuditChain(db: Db): ChainVerdict {
  const rows = db
    .prepare('SELECT id, request_id, at, kind, detail, prev_hash, hash FROM audit_events ORDER BY id')
    .all() as AuditRow[];

  let previous = GENESIS_HASH;
  let checked = 0;

  for (const row of rows) {
    if (row.prev_hash === null || row.hash === null) {
      return {
        ok: false,
        checked,
        brokenAtId: row.id,
        reason: `event ${row.id} has no hash, so it was written outside the chain`,
      };
    }
    if (row.prev_hash !== previous) {
      return {
        ok: false,
        checked,
        brokenAtId: row.id,
        reason: `event ${row.id} does not link to event ${row.id - 1}: a row was inserted, removed or reordered`,
      };
    }
    const expected = eventHash(previous, row.request_id, row.at, row.kind, row.detail);
    if (row.hash !== expected) {
      return {
        ok: false,
        checked,
        brokenAtId: row.id,
        reason: `event ${row.id} does not match its own contents, so it was edited after it was written`,
      };
    }
    previous = row.hash;
    checked += 1;
  }

  return { ok: true, checked, headHash: previous };
}
