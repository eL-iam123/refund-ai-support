import { describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { TEST_NOW } from './helpers.js';
import {
  authoriseRefund,
  itemIdsForRefund,
  pendingCentsForItem,
  settledCentsForItem,
  settleRefund,
  RefundLedgerError,
} from '../db/refundLedger.js';
import { insertRequest } from '../db/requestRepository.js';

/**
 * The per-line fold turns each approval into money that names the lines it was
 * calculated from, and this suite is about that naming being honest: the right
 * lines on the row, the right projection through the per-item reads, and a
 * refusal to describe money the named lines cannot back.
 */

interface Fixture {
  readonly db: Db;
  readonly customerId: string;
  readonly orderId: string;
  readonly lines: readonly { id: string; price: number }[];
}

/**
 * The first multi-line seeded order, which is settled, inside its window, and
 * un-refunded. Multi-line guarantees the coverage invariant can be exercised
 * against a line cheaper than the whole order.
 */
function refundableOrder(): Fixture {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  const order = db
    .prepare(
      `SELECT o.id AS order_id, o.customer_id
         FROM orders o
        WHERE (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) >= 2
        ORDER BY o.id LIMIT 1`,
    )
    .get() as { order_id: string; customer_id: string } | undefined;
  if (order === undefined) {
    throw new Error('seed produced no multi-line order');
  }
  const lines = db
    .prepare(
      `SELECT id, unit_price_cents * quantity AS price
         FROM order_items WHERE order_id = ? ORDER BY id`,
    )
    .all(order.order_id) as { id: string; price: number }[];
  return { db, customerId: order.customer_id, orderId: order.order_id, lines };
}

const REQUEST_ID = 'REQ-ITEM-1';

/** The fixture order is multi-line by construction, but TS needs proof. */
function twoLines(fixture: Fixture): [Line, Line] {
  const [first, second] = fixture.lines;
  if (first === undefined || second === undefined) {
    throw new Error('seed produced an order with fewer than two lines');
  }
  return [first, second];
}

type Line = { readonly id: string; readonly price: number };

function authorise(fixture: Fixture, amountCents: number, itemIds: readonly string[] | undefined): { id: string } {
  const at = TEST_NOW.toISOString();
  insertRequest(fixture.db, {
    id: REQUEST_ID,
    createdAt: at,
    customerId: fixture.customerId,
    customerName: 'Test Customer',
    orderId: fixture.orderId,
    message: 'fixture claim',
    messageSha256: '0'.repeat(64),
    messageFingerprint: '0'.repeat(64),
    decision: 'approved',
    refundAmountCents: amountCents,
    eligibleAmountCents: amountCents,
    summary: '',
    policyRef: '',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: '[]',
    claimItemIdsJson: '[]',
    blockedItemsJson: '[]',
    responseText: '',
    extractionJson: null,
    groundingJson: null,
    injectionJson: '[]',
    aiMode: 'fixed',
    llmCalled: false,
    timingsJson: '{}',
    scenarioId: null,
  });
  return authoriseRefund(fixture.db, {
    requestId: REQUEST_ID,
    orderId: fixture.orderId,
    customerId: fixture.customerId,
    amountCents,
    ...(itemIds !== undefined ? { itemIds } : {}),
    now: TEST_NOW,
  });
}

describe('per-line ledger coverage', () => {
  it('records the lines the money was calculated from', () => {
    const fixture = refundableOrder();
    const [first] = twoLines(fixture);
    const picked = [first.id];
    const authorised = authorise(fixture, first.price, picked);
    expect(itemIdsForRefund(fixture.db, authorised.id)).toEqual(picked);
  });

  it('reads an unscoped authorisation as covering the whole order', () => {
    const fixture = refundableOrder();
    const authorised = authorise(fixture, 100, undefined);
    expect(itemIdsForRefund(fixture.db, authorised.id)).toEqual(fixture.lines.map((line) => line.id));
  });

  it('refuses money the covered lines cannot back', () => {
    const fixture = refundableOrder();
    const total = fixture.lines.reduce((sum, line) => sum + line.price, 0);
    const sorted = [...fixture.lines].sort((a, b) => a.price - b.price);
    const cheapest = sorted[0];
    if (cheapest === undefined) {
      throw new Error('seed produced an order with no lines');
    }
    expect(cheapest.price).toBeLessThan(total);
    expect(() => authorise(fixture, total, [cheapest.id])).toThrow(RefundLedgerError);
  });

  it('keys pending and settled money to the covered line', () => {
    const fixture = refundableOrder();
    const [lone, sibling] = twoLines(fixture);
    const authorised = authorise(fixture, lone.price, [lone.id]);

    expect(pendingCentsForItem(fixture.db, fixture.orderId, lone.id)).toBe(lone.price);
    expect(pendingCentsForItem(fixture.db, fixture.orderId, sibling.id)).toBe(0);
    expect(settledCentsForItem(fixture.db, fixture.orderId, lone.id)).toBe(0);

    settleRefund(fixture.db, authorised.id, 'STAFF-TEST', TEST_NOW);
    expect(settledCentsForItem(fixture.db, fixture.orderId, lone.id)).toBe(lone.price);
    expect(settledCentsForItem(fixture.db, fixture.orderId, sibling.id)).toBe(0);
  });

  it('counts a multi-line refund against each line it covers', () => {
    const fixture = refundableOrder();
    const [first, second] = twoLines(fixture);
    const total = fixture.lines.reduce((sum, line) => sum + line.price, 0);
    const authorised = authorise(fixture, total, [first.id, second.id]);
    settleRefund(fixture.db, authorised.id, 'STAFF-TEST', TEST_NOW);
    expect(settledCentsForItem(fixture.db, fixture.orderId, first.id)).toBe(total);
    expect(settledCentsForItem(fixture.db, fixture.orderId, second.id)).toBe(total);
  });

  it('migrates a fresh database with the refund_items table', () => {
    const fixture = refundableOrder();
    const table = fixture.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refund_items'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('refund_items');
  });
});