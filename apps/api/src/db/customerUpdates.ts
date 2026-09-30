import type { Db } from './connection.js';
import { queryAll } from './sql.js';
import { randomUUID } from 'node:crypto';
import type { FollowUpKind } from '../response/followUp.js';

/**
 * Messages the customer has been sent about a request after a person acted.
 *
 * Written once, read as part of the conversation. The alternative - recomposing
 * the message when the thread is read - would mean the words a customer was
 * shown in March depend on code written in September, and a record that cannot
 * reproduce the message it sent cannot be reviewed.
 */

export interface CustomerUpdate {
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly requestId: string;
  readonly kind: FollowUpKind;
  readonly body: string;
}

interface UpdateRow {
  readonly id: string;
  readonly created_at: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly request_id: string;
  readonly kind: string;
  readonly body: string;
}

export interface RecordUpdateInput {
  readonly customerId: string;
  readonly orderId: string | null;
  readonly requestId: string;
  readonly kind: FollowUpKind;
  readonly body: string;
  readonly now: Date;
}

export function recordCustomerUpdate(db: Db, input: RecordUpdateInput): CustomerUpdate {
  const row: CustomerUpdate = {
    id: `UPD-${randomUUID()}`,
    createdAt: input.now.toISOString(),
    customerId: input.customerId,
    orderId: input.orderId,
    requestId: input.requestId,
    kind: input.kind,
    body: input.body,
  };
  db.prepare(
    `INSERT INTO customer_updates (id, created_at, customer_id, order_id, request_id, kind, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.createdAt, row.customerId, row.orderId, row.requestId, row.kind, row.body);
  return row;
}

/**
 * The updates belonging to one order's thread, oldest first.
 *
 * Scoped by customer as well as order, on the same reasoning as the request
 * history beside it: either condition is sufficient, and a filter that is the
 * only defence is one refactor away from not being one.
 */
export function listUpdatesForOrder(
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): readonly CustomerUpdate[] {
  const rows = queryAll<UpdateRow>(
    db.prepare(
      `SELECT id, created_at, customer_id, order_id, request_id, kind, body
         FROM customer_updates
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );
  return rows.map(hydrate).reverse();
}

function hydrate(row: UpdateRow): CustomerUpdate {
  return {
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    orderId: row.order_id,
    requestId: row.request_id,
    kind: row.kind as FollowUpKind,
    body: row.body,
  };
}
