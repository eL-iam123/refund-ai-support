import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { queryAll, queryOne } from './sql.js';

/**
 * A customer asking a person to look again at a refused request.
 *
 * Deciding an appeal is not a column flip here: it is the takeover machinery.
 * When a person takes over to talk the refusal through, they override the
 * request, and `applyHumanOverride` closes any open appeal as a side effect
 * (`closeAppealsForRequest`). That keeps the appeal store a queue of *open*
 * questions and nothing else, which is why this module has no "mark appealed and
 * restart the pipeline" escape hatch - the only way out of an open appeal is a
 * person's hands in it.
 *
 * `decided_at` being null is what makes an appeal live; the partial unique index
 * in the migration turns "the customer asked again" into a state rather than a
 * queue of repeat clicks, and `fileAppeal` re-checks it so a future author who
 * reads only this file still sees the invariant.
 */

export interface Appeal {
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly requestId: string;
  readonly reason: string;
}

interface AppealRow {
  readonly id: string;
  readonly created_at: string;
  readonly customer_id: string;
  readonly request_id: string;
  readonly reason: string;
}

export class AppealAlreadyPendingError extends Error {
  constructor(requestId: string) {
    super(`request ${requestId} already has an open appeal`);
    this.name = 'AppealAlreadyPendingError';
  }
}

export interface FileAppealInput {
  readonly requestId: string;
  readonly customerId: string;
  readonly reason: string;
  readonly now: Date;
}

export function fileAppeal(db: Db, input: FileAppealInput): Appeal {
  if (openAppealForRequest(db, input.requestId) !== null) {
    throw new AppealAlreadyPendingError(input.requestId);
  }
  const appeal: Appeal = {
    id: `APL-${randomUUID()}`,
    createdAt: input.now.toISOString(),
    customerId: input.customerId,
    requestId: input.requestId,
    reason: input.reason,
  };
  db.prepare(
    `INSERT INTO appeals (id, created_at, customer_id, request_id, reason, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(appeal.id, appeal.createdAt, appeal.customerId, appeal.requestId, appeal.reason);
  return appeal;
}

export function openAppealForRequest(db: Db, requestId: string): Appeal | null {
  const row = queryOne<AppealRow>(
    db.prepare(
      `SELECT id, created_at, customer_id, request_id, reason
         FROM appeals
        WHERE request_id = ? AND decided_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    ),
    requestId,
  );
  return row === null ? null : hydrate(row);
}

export function openAppealsForCustomer(db: Db, customerId: string): readonly Appeal[] {
  const rows = queryAll<AppealRow>(
    db.prepare(
      `SELECT id, created_at, customer_id, request_id, reason
         FROM appeals
        WHERE customer_id = ? AND decided_at IS NULL
        ORDER BY created_at ASC`,
    ),
    customerId,
  );
  return rows.map(hydrate);
}

export function openAppealsForThread(
  db: Db,
  customerId: string,
  orderId: string | null,
): readonly Appeal[] {
  const rows = queryAll<AppealRow>(
    db.prepare(
      `SELECT a.id, a.created_at, a.customer_id, a.request_id, a.reason
         FROM appeals a
         JOIN refund_requests r ON r.id = a.request_id
        WHERE a.customer_id = ? AND r.order_id IS ? AND a.decided_at IS NULL
        ORDER BY a.created_at ASC`,
    ),
    customerId,
    orderId,
  );
  return rows.map(hydrate);
}

export function closeAppealsForRequest(
  db: Db,
  requestId: string,
  decidedBy: string,
  now: Date,
): number {
  return db
    .prepare('UPDATE appeals SET decided_at = ?, decided_by = ? WHERE request_id = ? AND decided_at IS NULL')
    .run(now.toISOString(), decidedBy, requestId).changes;
}

function hydrate(row: AppealRow): Appeal {
  return {
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    requestId: row.request_id,
    reason: row.reason,
  };
}