import type { Db } from './connection.js';
import { SCENARIOS, type Scenario, type ScenarioOrder } from '@refund/shared';

/**
 * Seeds the mock CRM from the scenario definitions.
 *
 * Dates are always written as offsets from `now`, so S-04 stays 68 days old
 * however long after the project was written the reviewer runs it. A hard-coded
 * 2024 date would silently turn "order too old" into "order delivered today"
 * and quietly stop testing R-01.
 */

const DAY_MS = 86_400_000;

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function wipe(db: Db): void {
  db.exec(`
    DELETE FROM llm_calls;
    DELETE FROM audit_events;
    DELETE FROM refund_requests;
    DELETE FROM order_items;
    DELETE FROM orders;
    DELETE FROM customers;
  `);
}

function insertCustomer(db: Db, scenario: Scenario, now: Date): void {
  db.prepare(
    `INSERT INTO customers
       (id, name, email, tier, account_created_at, prior_refund_count, refund_requests_last_30d)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scenario.customer.key,
    scenario.customer.name,
    scenario.customer.email,
    scenario.customer.tier,
    daysAgo(now, scenario.customer.accountAgeDays).toISOString(),
    scenario.customer.priorRefundCount,
    scenario.customer.refundRequestsLast30Days,
  );
}

function insertOrder(db: Db, order: ScenarioOrder, customerId: string, now: Date): void {
  db.prepare(
    `INSERT INTO orders
       (id, customer_id, placed_at, delivered_at, status, payment_state, refunded_cents,
        is_subscription, tracking_status, signed_by_customer, condition_at_delivery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.key,
    customerId,
    daysAgo(now, order.placedDaysAgo).toISOString(),
    order.deliveredDaysAgo === null ? null : daysAgo(now, order.deliveredDaysAgo).toISOString(),
    order.status,
    order.paymentState,
    order.refundedCents,
    order.isSubscription ? 1 : 0,
    order.trackingStatus,
    order.signedByCustomer ? 1 : 0,
    order.conditionAtDelivery,
  );

  const insertItem = db.prepare(
    `INSERT INTO order_items
       (id, order_id, name, unit_price_cents, quantity, final_sale, digital, downloaded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of order.items) {
    insertItem.run(
      item.key,
      order.key,
      item.name,
      item.unitPriceCents,
      item.quantity,
      item.finalSale ? 1 : 0,
      item.digital ? 1 : 0,
      item.downloaded ? 1 : 0,
    );
  }
}

export function seedDatabase(db: Db, now: Date): number {
  wipe(db);

  const insertCustomerTx = db.transaction((customerId: string, orders: readonly ScenarioOrder[]) => {
    for (const order of orders) {
      insertOrder(db, order, customerId, now);
    }
  });

  for (const scenario of SCENARIOS) {
    const exists = db
      .prepare('SELECT 1 AS present FROM customers WHERE id = ?')
      .get(scenario.customer.key);
    if (exists === undefined) {
      insertCustomer(db, scenario, now);
    }
    insertCustomerTx(scenario.customer.key, scenario.orders);
  }

  return SCENARIOS.length;
}
