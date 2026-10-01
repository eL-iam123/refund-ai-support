import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { FULLY_REFUNDED } from '../policy/constants.js';

/**
 * The refund ledger: money that has moved, and money that has not.
 *
 * `orders.refunded_cents` is a fact - it counts payments that actually settled.
 * An approval is not a payment; it is a decision that a payment *should* happen,
 * and between those two things sits a person who has to check. So an approved
 * decision writes a `pending_verification` row here, and only a human moving it
 * to `settled` increases what the order has been refunded by.
 *
 * The two states are kept apart for a specific reason. If approval immediately
 * incremented the order, then a request that was approved and later denied by a
 * reviewer would leave the order permanently over-refunded, because nothing
 * decrements it. If settlement alone incremented it, nothing would be reserved
 * while the queue drains and the same order could be approved a dozen times over.
 * So both are needed: the order counts what left the till, and this table
 * reserves what is about to.
 */

type Db = Database.Database;

export const REFUND_STATUSES = ['pending_verification', 'settled', 'released'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export interface RefundRecord {
  readonly id: string;
  readonly requestId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly status: RefundStatus;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}

interface RefundRow {
  readonly id: string;
  readonly request_id: string;
  readonly order_id: string;
  readonly customer_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly verified_by: string | null;
  readonly verified_at: string | null;
  readonly settled_at: string | null;
  readonly released_at: string | null;
  readonly release_reason: string | null;
}

/** A failure in the ledger is a bug in the caller, not a bad customer request. */
export class RefundLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundLedgerError';
  }
}

/** The order no longer has enough uncommitted balance for this reservation. */
export class RefundBalanceExceededError extends RefundLedgerError {
  constructor(message: string) {
    super(message);
    this.name = 'RefundBalanceExceededError';
  }
}

const COLUMNS = `
  id, request_id, order_id, customer_id, amount_cents, currency, status,
  idempotency_key, created_at, verified_by, verified_at, settled_at,
  released_at, release_reason
`;

function hydrate(row: RefundRow): RefundRecord {
  if (!(REFUND_STATUSES as readonly string[]).includes(row.status)) {
    // The column has a CHECK, so this means the constraint was bypassed or the
    // file is corrupt. Failing here beats acting on a status nobody can name.
    throw new RefundLedgerError(`refunds.status holds "${row.status}", which is not a known status`);
  }
  return {
    id: row.id,
    requestId: row.request_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    amountCents: row.amount_cents,
    currency: row.currency === 'USD' ? 'USD' : (row.currency as 'USD'),
    status: row.status as RefundStatus,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

/**
 * A key that is stable for one request's authorisation.
 *
 * Derived rather than random so that re-running the pipeline for the same request
 * produces the same key, which is what makes the UNIQUE constraint an
 * idempotency guarantee rather than merely a duplicate-row guard: a payment
 * processor that has seen this key already will refuse the second attempt.
 */
function idempotencyKeyFor(requestId: string, orderId: string, amountCents: number): string {
  return createHash('sha256')
    .update(`${requestId}:${orderId}:${amountCents}`, 'utf8')
    .digest('hex');
}

export interface AuthoriseInput {
  readonly requestId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly now: Date;
}

/**
 * Records an approved amount as awaiting human verification.
 *
 * Idempotent on `requestId`: asking twice for the same request returns the row
 * that already exists rather than reserving the money twice. Returns the existing
 * row unchanged, so a caller can treat this as "ensure authorised".
 */
export function authoriseRefund(db: Db, input: AuthoriseInput): RefundRecord {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    // Only money is reserved. An approval of $0 is a decision, not a payment.
    throw new RefundLedgerError(`refund authorisation must be for a positive whole-cent amount, got ${input.amountCents}`);
  }

  return db.transaction((): RefundRecord => {
    const existing = findRefundByRequestId(db, input.requestId);
    if (existing !== null) {
      if (
        existing.orderId !== input.orderId ||
        existing.customerId !== input.customerId ||
        existing.amountCents !== input.amountCents
      ) {
        throw new RefundLedgerError(`refund request ${input.requestId} was reused with different authorisation details`);
      }
      // Released means the approval that created it was undone. If the decision
      // is approved again, reserve the balance again, but never past what remains.
      if (existing.status !== 'released') {
        return existing;
      }
      assertRefundableBalance(db, input);
      reopenReleased(db, existing.id);
      const reopened = findRefundById(db, existing.id);
      if (reopened === null) {
        throw new RefundLedgerError(`refund ${existing.id} vanished while being reopened`);
      }
      return reopened;
    }

    assertRefundableBalance(db, input);
    const id = `RFD-${randomUUID()}`;
    const createdAt = input.now.toISOString();
    db.prepare(
      `INSERT INTO refunds (
         id, request_id, order_id, customer_id, amount_cents, currency, status,
         idempotency_key, created_at, verified_by, verified_at, settled_at,
         released_at, release_reason
       ) VALUES (?, ?, ?, ?, ?, 'USD', 'pending_verification', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
      id,
      input.requestId,
      input.orderId,
      input.customerId,
      input.amountCents,
      idempotencyKeyFor(input.requestId, input.orderId, input.amountCents),
      createdAt,
    );

    const created = findRefundById(db, id);
    if (created === null) {
      throw new RefundLedgerError(`refund ${id} vanished immediately after insert`);
    }
    return created;
  })();
}

/** Enforces the balance at the write boundary, including legacy settled money. */
function assertRefundableBalance(db: Db, input: AuthoriseInput): void {
  const order = db
    .prepare(
      `SELECT o.customer_id, o.refunded_cents,
              COALESCE(SUM(i.unit_price_cents * i.quantity), 0) AS total_cents
         FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
        WHERE o.id = ? GROUP BY o.id`,
    )
    .get(input.orderId) as { customer_id: string; refunded_cents: number; total_cents: number } | undefined;
  if (order === undefined || order.customer_id !== input.customerId) {
    throw new RefundLedgerError(`order ${input.orderId} does not belong to customer ${input.customerId}`);
  }

  const settled = Math.max(order.refunded_cents, settledCentsForOrder(db, input.orderId));
  const pending = pendingCentsForOrder(db, input.orderId);
  const remaining = order.total_cents - settled - pending;
  if (input.amountCents > remaining) {
    throw new RefundBalanceExceededError(
      `cannot reserve ${input.amountCents} cents: order ${input.orderId} has only ${Math.max(0, remaining)} cents remaining`,
    );
  }
}

/**
 * Puts a released reservation back in the queue.
 *
 * The reason is cleared rather than carried forward, so a pending row never
 * reports a release that no longer applies to it. The history of who released it
 * and why lives in `audit_events`, which is the right place for it: it is a
 * record of acts, and a ledger row is the current state of one authorisation.
 *
 * This is the same reservation revisited, not a new one, so the UNIQUE(request_id)
 * that stops one request reserving the same money twice still holds.
 */
function reopenReleased(db: Db, id: string): void {
  db.prepare(
    `UPDATE refunds SET status = 'pending_verification', released_at = NULL, release_reason = NULL
      WHERE id = ? AND status = 'released'`,
  ).run(id);
}

export function findRefundById(db: Db, id: string): RefundRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM refunds WHERE id = ?`).get(id) as RefundRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function findRefundByRequestId(db: Db, requestId: string): RefundRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM refunds WHERE request_id = ?`).get(requestId) as
    | RefundRow
    | undefined;
  return row === undefined ? null : hydrate(row);
}

export function findRefundByIdempotencyKey(db: Db, key: string): RefundRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM refunds WHERE idempotency_key = ?`).get(key) as
    | RefundRow
    | undefined;
  return row === undefined ? null : hydrate(row);
}

/** Money already paid out against an order. This is what moves the order total. */
export function settledCentsForOrder(db: Db, orderId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE order_id = ? AND status = 'settled'")
    .get(orderId) as { total: number };
  return row.total;
}

/** Money authorised but not yet paid, which is reserved against this order. */
export function pendingCentsForOrder(db: Db, orderId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE order_id = ? AND status = 'pending_verification'",
    )
    .get(orderId) as { total: number };
  return row.total;
}

/** Refunds for one request, newest first, for the order history view. */
export function listRefundsForOrder(db: Db, orderId: string): RefundRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM refunds WHERE order_id = ? ORDER BY created_at DESC, id DESC`)
    .all(orderId) as RefundRow[];
  return rows.map(hydrate);
}

export function listRefundsByStatus(db: Db, status: RefundStatus): RefundRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM refunds WHERE status = ? ORDER BY created_at ASC`)
    .all(status) as RefundRow[];
  return rows.map(hydrate);
}

/**
 * Moves an authorisation to settled, and counts the money against the order.
 *
 * The order update and the status change are one transaction on purpose: an
 * order that says it was refunded with no ledger row to match is the exact
 * disagreement this ledger exists to make impossible, and the reverse - a settled
 * refund the order does not know about - would let the gates approve the same
 * money a second time.
 *
 * Refuses to settle more than the order is worth, or more than is left of it.
 */
export function settleRefund(db: Db, id: string, agentId: string, now: Date): RefundRecord {
  return db.transaction((): RefundRecord => {
    const refund = findRefundById(db, id);
    if (refund === null) {
      throw new RefundLedgerError(`no refund with id "${id}"`);
    }
    if (refund.status === 'settled') {
      throw new RefundLedgerError(
        `refund ${id} is already settled, so approving it again would pay twice; ` +
          'check the ledger by idempotency key if you believe it was missed',
      );
    }
    if (refund.status === 'released') {
      throw new RefundLedgerError(
        `refund ${id} was released (${refund.releaseReason ?? 'no reason recorded'}), so there is nothing to pay`,
      );
    }

    const order = db
      .prepare(
        `SELECT o.refunded_cents,
                COALESCE(SUM(i.unit_price_cents * i.quantity), 0) AS total
           FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
          WHERE o.id = ? GROUP BY o.id`,
      )
      .get(refund.orderId) as { refunded_cents: number; total: number } | undefined;
    if (order === undefined) {
      throw new RefundLedgerError(`order ${refund.orderId} no longer exists`);
    }
    // Preserve money settled before the ledger existed. The order column and
    // ledger are two views of settled refunds; take the larger, never their sum.
    const already = Math.max(order.refunded_cents, settledCentsForOrder(db, refund.orderId));
    const pending = pendingCentsForOrder(db, refund.orderId);

    if (already + pending > order.total) {
      throw new RefundLedgerError(
        `settling this reservation would leave ${already + pending} cents refunded or reserved of ` +
          `${order.total} cents paid, which exceeds the order balance`,
      );
    }

    const at = now.toISOString();
    db.prepare(
      `UPDATE refunds SET status = 'settled', verified_by = ?, verified_at = ?, settled_at = ?
        WHERE id = ? AND status = 'pending_verification'`,
    ).run(agentId, at, at, id);

    const total = already + refund.amountCents;
    db.prepare(
      `UPDATE orders
          SET refunded_cents = ?,
              payment_state = CASE WHEN ? >= (
                    SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_items WHERE order_id = ?
                ) THEN ? ELSE 'partially_refunded' END
        WHERE id = ?`,
    ).run(total, total, refund.orderId, FULLY_REFUNDED, refund.orderId);

    const settled = findRefundById(db, id);
    if (settled === null) {
      throw new RefundLedgerError(`refund ${id} vanished during settlement`);
    }
    return settled;
  })();
}

/**
 * Releases an authorisation without paying it.
 *
 * Used when the approval is undone - a reviewer denies a request that had already
 * reserved money. Without this the reservation would sit against the order
 * forever and quietly reduce what the customer can ever claim, which is a
 * customer-facing harm caused entirely by bookkeeping.
 */
export function releaseRefund(db: Db, id: string, reason: string, now: Date): RefundRecord {
  return db.transaction((): RefundRecord => {
    const refund = findRefundById(db, id);
    if (refund === null) {
      throw new RefundLedgerError(`no refund with id "${id}"`);
    }
    if (refund.status !== 'pending_verification') {
      throw new RefundLedgerError(`refund ${id} is ${refund.status}, so there is nothing pending to release`);
    }

    db.prepare(
      "UPDATE refunds SET status = 'released', release_reason = ?, released_at = ?, verified_by = ? WHERE id = ?",
    ).run(reason, now.toISOString(), null, id);

    const released = findRefundById(db, id);
    if (released === null) {
      throw new RefundLedgerError(`refund ${id} vanished during release`);
    }
    return released;
  })();
}

/**
 * Releases whatever an undone approval had reserved.
 *
 * Called when a human overrides a request to a decision that authorises no money,
 * so the reservation does not outlive the decision that created it. Returns the
 * rows released, or an empty list when there was nothing pending.
 */
export function releaseRefundsForRequest(db: Db, requestId: string, reason: string, now: Date): RefundRecord[] {
  const pending = db
    .prepare(`SELECT ${COLUMNS} FROM refunds WHERE request_id = ? AND status = 'pending_verification'`)
    .all(requestId) as RefundRow[];
  return pending.map((row) => releaseRefund(db, row.id, reason, now));
}
