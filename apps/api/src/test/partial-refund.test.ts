import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { SCENARIOS, type RefundRequestDto } from '@refund/shared';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { sessionFor } from './shop-helpers.js';
import { daysAgo } from '../db/seed.js';
import type { Db } from '../db/connection.js';

/**
 * Partial refunds on a multi-item order.
 *
 * One checkout, several products, a customer who wants money back for some of
 * them and nothing for the rest: "the TV arrived cracked, but I'd also like to
 * send the shoes back, they're the wrong size." This is ordinary retail, and it
 * is the case where a whole-order refund does the most damage - it hands back
 * money for the lamp and the bag that the customer is perfectly happy to keep.
 *
 * The 18 canonical scenarios all use single-item orders, so nothing else in the
 * suite can catch it. These tests build a four-item order directly for that
 * reason.
 */

interface CreatedResponse {
  readonly request: RefundRequestDto;
}

const CUSTOMER = 'CUST-AOKAFOR';
const ORDER = 'ORD-9001';
const TV = 'ITM-9001-TV';
const SHOES = 'ITM-9001-SHOES';
const LAMP = 'ITM-9001-LAMP';
const BAG = 'ITM-9001-BAG';

const TV_CENTS = 20000;
const SHOES_CENTS = 8000;
const LAMP_CENTS = 5000;
const BAG_CENTS = 7000;
const ORDER_TOTAL = TV_CENTS + SHOES_CENTS + LAMP_CENTS + BAG_CENTS;

/** A shopping spree: lamp, shoes, TV and bag, bought and delivered together. */
function seedSpree(db: Db): void {
  db.prepare(
    `INSERT INTO orders (id, customer_id, placed_at, delivered_at, status, payment_state,
       refunded_cents, is_subscription, tracking_status, signed_by_customer, condition_at_delivery)
     VALUES (?, ?, ?, ?, 'delivered', 'captured', 0, 0, 'delivered', 1, 'good')`,
  ).run(ORDER, CUSTOMER, daysAgo(TEST_NOW, 9).toISOString(), daysAgo(TEST_NOW, 5).toISOString());

  const insert = db.prepare(
    `INSERT INTO order_items (id, order_id, name, unit_price_cents, quantity, final_sale, digital, downloaded)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
  );
  insert.run(LAMP, ORDER, 'Aria Floor Lamp', LAMP_CENTS);
  insert.run(SHOES, ORDER, 'Trail Running Shoes', SHOES_CENTS);
  insert.run(TV, ORDER, 'NOVA 43" Television', TV_CENTS);
  insert.run(BAG, ORDER, 'Canvas Weekender Bag', BAG_CENTS);
}

describe('partial refunds across a multi-item order', () => {
  let harness: AppHarness;
  let cookie: string;

  beforeEach(async () => {
    harness = await appHarness();
    seedSpree(harness.db);
    cookie = await sessionFor(harness, CUSTOMER);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function submit(message: string): Promise<RefundRequestDto> {
    const response: LightMyRequestResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie },
      payload: { customerId: CUSTOMER, orderId: ORDER, message },
    });
    expect(response.statusCode).toBe(201);
    const { request } = response.json<CreatedResponse>();
    return request;
  }

  it('refunds only the item the customer complained about, not the whole order', async () => {
    const request = await submit('The TV arrived with a cracked screen. I want a refund for the television.');

    // The order totals $400. Only the $200 television is in dispute, so $400 is
    // a $200 over-refund handed to a customer who asked for half of it.
    expect(ORDER_TOTAL).toBe(40000);
    expect(request.decision.refundAmountCents).toBe(TV_CENTS);
    expect(request.decision.refundAmountCents).toBeLessThan(ORDER_TOTAL);
  });

  it('never pays more than the items the customer actually named', async () => {
    const request = await submit('The television screen is cracked, I would like my money back for the TV.');

    expect(request.decision.refundAmountCents).toBeLessThanOrEqual(TV_CENTS);
  });

  it('records why the amount was limited, so the cap is auditable', async () => {
    const request = await submit('The television is broken and I want my money back for it.');

    const cap = request.decision.overrides.find(
      (entry) => entry.code === 'amount_limited_to_disputed_items',
    );
    expect(cap).toBeDefined();
    expect(cap?.detail).toContain('specific products');
  });

  it('refuses to approve more than the disputed portion when two reasons are given', async () => {
    // Two items, two different reasons. Whatever the extraction manages to
    // represent, the payout must not quietly become the order total.
    const request = await submit(
      'The TV screen is cracked so I want a refund for the television. ' +
        'Separately the running shoes are the wrong size, I would like to return those too.',
    );

    expect(request.decision.refundAmountCents).toBeLessThan(ORDER_TOTAL);
  });

  it('does not lose track of which order the request belongs to', async () => {
    const request = await submit('The television is broken, I want a refund.');

    expect(request.orderId).toBe(ORDER);
  });

  it('still keeps every scenario customer intact', () => {
    // Guards against a seeding change that would make the spree fixtures and the
    // canonical scenarios collide on ids.
    expect(SCENARIOS.some((entry) => entry.orders.some((order) => order.key === ORDER))).toBe(false);
  });
});
