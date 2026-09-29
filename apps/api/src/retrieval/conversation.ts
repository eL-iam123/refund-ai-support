import type { Db } from '../db/connection.js';
import { queryAll } from '../db/sql.js';
import { findOrder } from '../db/orderRepository.js';
import { listUpdatesForOrder } from '../db/customerUpdates.js';
import { NotFoundError } from '../http/errors.js';

/**
 * A customer's conversation, per order.
 *
 * Everything the assistant already knows is already stored: `refund_requests`
 * holds the message, the composed reply, the decision and when it happened. This
 * turns those rows back into a thread, so an order's history survives a refresh
 * and is reachable from the order the customer is actually looking at.
 *
 * Three things this deliberately does not do:
 *
 *  - **Take a `customerId`.** The caller is identified by the session cookie and
 *    nothing else. A parameter here would be a parameter an attacker sets, and
 *    the whole query would be `WHERE customer_id = ?` - the safest query in the
 *    system turned into the most dangerous one by one extra field.
 *
 *  - **Check the order belongs to the customer and then read the rows.** The
 *    ownership check is not decoration: the history query filters by customer as
 *    well, but a filter that is the *only* defence is one refactor away from
 *    being dropped. Two independent conditions, either of which is sufficient.
 *
 *  - **Return the full request row.** A refund request carries the policy trace,
 *    the raw extraction, the injection scan and the timing breakdown. That is
 *    staff data. The customer gets the message they sent, the answer they were
 *    given, and the outcome - which is the whole of what a thread needs to read
 *    correctly.
 */

/**
 * One entry in the thread.
 *
 * A `request` entry is the customer asking something and the answer they were
 * given. An `update` entry is the assistant telling them what a person later did
 * about it - approved, paid, or withdrawn - and carries no message, because the
 * customer did not send one.
 *
 * The two are told apart in the type rather than by a null check at the renderer,
 * so a missing message is a compile error rather than an empty bubble.
 */
export type ChatTurn =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly message: string;
      readonly responseText: string;
      readonly decision: string;
      readonly refundAmountCents: number;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'update';
      readonly id: string;
      readonly requestId: string;
      readonly body: string;
      readonly createdAt: string;
    };

interface TurnRow {
  readonly id: string;
  readonly message: string;
  readonly response_text: string;
  readonly decision: string;
  readonly refund_amount_cents: number;
  readonly created_at: string;
}

/**
 * The thread for one order, oldest first.
 *
 * Oldest first because a conversation is read in order. A history rendered
 * newest-first is a history where the answer to the first question appears
 * below every later question that was asked after it was already answered.
 *
 * Capped, and capped in a way that takes the *oldest* of the most recent turns
 * rather than the oldest turns overall. A customer with fifty messages wants
 * their recent ones, not their first; a customer with three wants all three.
 *
 * The ordering is `created_at` then `rowid`, and the tiebreak is not decoration.
 * Two messages can share a timestamp - same millisecond, or a fixed clock in a
 * test - and the only column left to break the tie is `id`, a random UUID, which
 * orders them arbitrarily. A thread whose last two messages can swap places
 * between two page loads is not a thread. `rowid` is assigned in insertion order
 * and these rows are only ever inserted, so it is the one column here that
 * reliably means "which happened first".
 */
export function conversationForOrder(
  db: Db,
  customerId: string,
  orderId: string,
  now: Date,
  limit: number,
): readonly ChatTurn[] {
  // 404 rather than 403 for someone else's order. A 403 confirms the order
  // exists, which turns this into an order-id oracle - the same reasoning the
  // return ledger and the refund pipeline both rely on.
  if (findOrder(db, customerId, orderId, now) === null) {
    // The message names the order id back, which is the same phrasing the rest of
    // the shop uses for a missing thing. It deliberately does not say whose order
    // it is or that the order exists at all.
    throw new NotFoundError('order', orderId);
  }

  const rows = queryAll<TurnRow>(
    db.prepare(
      `SELECT id, message, response_text, decision, refund_amount_cents, created_at
         FROM refund_requests
        WHERE customer_id = ? AND order_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );

  // Reversed rather than queried ascending: `ORDER BY … DESC LIMIT ?` is the only
  // way to take the *most recent* N without loading the whole thread, and a
  // conversation still has to be read in the order it happened.
  const requests = rows
    .map(hydrateTurn)
    .reverse()
    .map((turn) => ({ turn, rank: 0 }));

  // Asked for separately rather than joined. A UNION ALL over two tables that
  // need different orderings to be correct would put the tiebreak logic in SQL,
  // where the reason for it cannot be explained; here the rule is three lines
  // and says what it does.
  const updates = listUpdatesForOrder(db, customerId, orderId, limit)
    .map((update) => ({
      turn: {
        kind: 'update' as const,
        id: update.id,
        requestId: update.requestId,
        body: update.body,
        createdAt: update.createdAt,
      },
      rank: 1,
    }));

  return merge(requests, updates);
}

/**
 * Interleaves the two halves of the thread into one readable order.
 *
 * The `rank` tiebreak is the part worth stating. An update can share a timestamp
 * with the request it answers - same millisecond, or a fixed clock in a test -
 * and the customer's own message must come first, because that is the order the
 * conversation happened in. Sorting on the timestamp alone would let the reply
 * sort before the question.
 */
function merge(
  requests: readonly { readonly turn: ChatTurn; readonly rank: number }[],
  updates: readonly { readonly turn: ChatTurn; readonly rank: number }[],
): readonly ChatTurn[] {
  return [...requests, ...updates]
    .sort((a, b) => {
      const when = a.turn.createdAt.localeCompare(b.turn.createdAt);
      return when !== 0 ? when : a.rank - b.rank;
    })
    .map((entry) => entry.turn);
}

/** Total messages per order, for the "3 messages" badge on the order list. */
export function conversationCounts(db: Db, customerId: string): ReadonlyMap<string, number> {
  const rows = queryAll<{ order_id: string; n: number }>(
    db.prepare(
      `SELECT order_id, COUNT(*) AS n
         FROM refund_requests
        WHERE customer_id = ? AND order_id IS NOT NULL
        GROUP BY order_id`,
    ),
    customerId,
  );
  return new Map(rows.map((row) => [row.order_id, row.n]));
}

function hydrateTurn(row: TurnRow): ChatTurn {
  return {
    kind: 'request',
    requestId: row.id,
    message: row.message,
    responseText: row.response_text,
    decision: row.decision,
    refundAmountCents: row.refund_amount_cents,
    createdAt: row.created_at,
  };
}
