import type { Db } from './connection.js';
import { findCustomer, listCustomers, queryAll, queryOne } from './sql.js';
import type { OrderItemRecord, OrderRecord } from './records.js';

export { findCustomer, listCustomers };

interface OrderRow {
  readonly id: string;
  readonly customer_id: string;
  readonly placed_at: string;
  readonly delivered_at: string | null;
  readonly status: string;
  readonly payment_state: string;
  readonly refunded_cents: number;
  readonly is_subscription: number;
  readonly tracking_status: string;
  readonly signed_by_customer: number;
  readonly condition_at_delivery: string | null;
}

interface ItemRow {
  readonly id: string;
  readonly order_id: string;
  readonly name: string;
  readonly unit_price_cents: number;
  readonly quantity: number;
  readonly final_sale: number;
  readonly digital: number;
  readonly downloaded: number;
  readonly is_subscription: number;
}

const ORDER_COLUMNS = `
  id, customer_id, placed_at, delivered_at, status, payment_state,
  refunded_cents, is_subscription, tracking_status, signed_by_customer, condition_at_delivery
`;

function ageInDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

function itemsFor(db: Db, orderId: string): OrderItemRecord[] {
  const rows = queryAll<ItemRow>(
    db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id'),
    orderId,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    finalSale: row.final_sale === 1,
    digital: row.digital === 1,
    downloaded: row.downloaded === 1,
    isSubscription: row.is_subscription === 1,
  }));
}

function hydrate(db: Db, row: OrderRow, now: Date): OrderRecord {
  const items = itemsFor(db, row.id);
  const placedAt = new Date(row.placed_at);
  const deliveredAt = row.delivered_at === null ? null : new Date(row.delivered_at);
  return {
    id: row.id,
    customerId: row.customer_id,
    placedAt,
    deliveredAt,
    ageDays: ageInDays(deliveredAt ?? placedAt, now),
    status: row.status as OrderRecord['status'],
    paymentState: row.payment_state as OrderRecord['paymentState'],
    refundedCents: row.refunded_cents,
    totalCents: items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0),
    isSubscription: row.is_subscription === 1,
    trackingStatus: row.tracking_status as OrderRecord['trackingStatus'],
    signedByCustomer: row.signed_by_customer === 1,
    conditionAtDelivery: row.condition_at_delivery,
    items,
  };
}

/**
 * Loads an order **only if the named customer owns it**.
 *
 * The customer id is part of the lookup, not a check applied afterwards, so
 * there is no code path that can fetch an order by id alone. That distinction
 * is the whole point: order ids are guessable and sequential, and a lookup that
 * ignores ownership turns "my order is ORD-1003" into "I can read anyone's
 * order, and have a refund decision written against it".
 */
export function findOrder(
  db: Db,
  customerId: string,
  orderId: string,
  now: Date,
): OrderRecord | null {
  const row = queryOne<OrderRow>(
    db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? AND customer_id = ?`),
    orderId,
    customerId,
  );
  return row === null ? null : hydrate(db, row, now);
}

export function listOrdersForCustomer(db: Db, customerId: string, now: Date): OrderRecord[] {
  const rows = queryAll<OrderRow>(
    db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE customer_id = ? ORDER BY placed_at DESC`),
    customerId,
  );
  return rows.map((row) => hydrate(db, row, now));
}

/**
 * Finds a same-day, same-value sibling order. Feeds R-11: a genuine duplicate
 * charge is a pattern in the data, not something a customer has to be believed for.
 */
export function findDuplicateSibling(db: Db, order: OrderRecord, now: Date): OrderRecord | null {
  const placedDay = order.placedAt.toISOString().slice(0, 10);
  const candidates = queryAll<OrderRow>(
    db.prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders
       WHERE customer_id = ? AND id != ? AND substr(placed_at, 1, 10) = ?`,
    ),
    order.customerId,
    order.id,
    placedDay,
  );

  for (const candidate of candidates) {
    const hydrated = hydrate(db, candidate, now);
    if (hydrated.totalCents === order.totalCents && hydrated.paymentState === 'settled') {
      return hydrated;
    }
  }
  return null;
}
