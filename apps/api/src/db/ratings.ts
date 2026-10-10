import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { findRequestById } from './requestRepository.js';

export type RatingValue = 'up' | 'down';

export interface RatingRecord {
  readonly id: string;
  readonly requestId: string;
  readonly customerId: string;
  readonly rating: RatingValue;
  readonly createdAt: string;
}

export class RatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatingError';
  }
}

/**
 * One customer's verdict on one answer.
 *
 * Upserted, not appended: a changed mind replaces the row rather than stacking
 * beside it, so counting verdicts never has to decide which one counts. The
 * request must belong to the voting customer - a verdict on someone else's
 * answer is not feedback, it is noise at best.
 */
export function rateReply(
  db: Db,
  input: { requestId: string; customerId: string; rating: RatingValue; now: Date },
): RatingRecord {
  const request = findRequestById(db, input.requestId);
  if (request === null || request.customerId !== input.customerId) {
    throw new RatingError(`no request ${input.requestId} for this customer`);
  }
  const at = input.now.toISOString();
  const existing = db
    .prepare('SELECT id FROM response_ratings WHERE request_id = ? AND customer_id = ?')
    .get(input.requestId, input.customerId) as { id: string } | undefined;
  if (existing === undefined) {
    const record: RatingRecord = {
      id: `RATE-${randomUUID()}`,
      requestId: input.requestId,
      customerId: input.customerId,
      rating: input.rating,
      createdAt: at,
    };
    db.prepare(
      'INSERT INTO response_ratings (id, request_id, customer_id, rating, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(record.id, record.requestId, record.customerId, record.rating, record.createdAt);
    return record;
  }
  db.prepare('UPDATE response_ratings SET rating = ?, created_at = ? WHERE id = ?').run(
    input.rating,
    at,
    existing.id,
  );
  return { id: existing.id, requestId: input.requestId, customerId: input.customerId, rating: input.rating, createdAt: at };
}

/** This customer's verdicts on one order's answers, newest first. */
export function ratingsForOrder(db: Db, customerId: string, orderId: string): readonly RatingRecord[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.request_id, r.customer_id, r.rating, r.created_at
         FROM response_ratings r
         JOIN refund_requests q ON q.id = r.request_id
        WHERE r.customer_id = ? AND q.order_id IS ?
        ORDER BY r.created_at DESC, r.rowid DESC`,
    )
    .all(customerId, orderId) as {
    id: string;
    request_id: string;
    customer_id: string;
    rating: string;
    created_at: string;
  }[];
  return rows
    .filter((row) => row.rating === 'up' || row.rating === 'down')
    .map((row) => ({
      id: row.id,
      requestId: row.request_id,
      customerId: row.customer_id,
      rating: row.rating as RatingValue,
      createdAt: row.created_at,
    }));
}
