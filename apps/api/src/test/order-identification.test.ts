import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { RefundRequestDto } from '@refund/shared';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { sessionFor } from './shop-helpers.js';
import { daysAgo } from '../db/seed.js';
import type { Db } from '../db/connection.js';

/**
 * Order identification.
 *
 * "I bought this lamp, it cost $300, I want a refund" contains no order id, and
 * every decision about money downstream depends on which order that turns out to
 * mean. The old behaviour - assume the most recent order - was silent, so it
 * could refund an order the customer did not mean and refuse a genuine claim,
 * with nothing in the audit trail to show for it.
 *
 * These tests pin the replacement: resolve from what the customer actually
 * bought, and escalate whenever the evidence is not unique. Every scenario
 * fixture customer owns exactly one order, which makes them unable to exercise
 * this at all, so the customer here is built directly.
 */

interface CreatedResponse {
  readonly request: RefundRequestDto;
}

const CUSTOMER = 'CUST-9001';
const LAMP_ORDER = 'ORD-9101';
const MUG_ORDER = 'ORD-9102';
const HEADPHONE_ORDER = 'ORD-9103';
const STRANGER_ORDER = 'ORD-1001';

/** Three ordinary orders, so every reference below is genuinely ambiguous. */
function seedHistory(db: Db): void {
  db.prepare(
    `INSERT INTO customers (id, name, email, tier, account_created_at, prior_refund_count, refund_requests_last_30d)
     VALUES (?, 'Test Buyer', 'test.buyer@example.com', 'standard', ?, 0, 0)`,
  ).run(CUSTOMER, daysAgo(TEST_NOW, 400).toISOString());

  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_id, placed_at, delivered_at, status, payment_state,
       refunded_cents, is_subscription, tracking_status, signed_by_customer, condition_at_delivery)
     VALUES (?, ?, ?, ?, 'delivered', 'captured', 0, 0, 'delivered', 1, 'good')`,
  );
  insertOrder.run(LAMP_ORDER, CUSTOMER, daysAgo(TEST_NOW, 8).toISOString(), daysAgo(TEST_NOW, 4).toISOString());
  insertOrder.run(MUG_ORDER, CUSTOMER, daysAgo(TEST_NOW, 30).toISOString(), daysAgo(TEST_NOW, 26).toISOString());
  insertOrder.run(HEADPHONE_ORDER, CUSTOMER, daysAgo(TEST_NOW, 60).toISOString(), daysAgo(TEST_NOW, 55).toISOString());

  const insertItem = db.prepare(
    `INSERT INTO order_items (id, order_id, name, unit_price_cents, quantity, final_sale, digital, downloaded)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
  );
  insertItem.run('ITM-9101-A', LAMP_ORDER, 'Aria Floor Lamp', 30000);
  insertItem.run('ITM-9102-A', MUG_ORDER, 'Ceramic Mug Set', 10000);
  insertItem.run('ITM-9103-A', HEADPHONE_ORDER, 'Studio Headphones', 32000);
}

describe('identifying which order a request is about', () => {
  let harness: AppHarness;
  let cookie: string;

  beforeEach(async () => {
    harness = await appHarness();
    seedHistory(harness.db);
    cookie = await sessionFor(harness, CUSTOMER);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function submit(payload: Record<string, unknown>): Promise<RefundRequestDto> {
    const response: LightMyRequestResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie },
      payload: { customerId: CUSTOMER, ...payload },
    });
    expect(response.statusCode).toBe(201);
    const { request } = response.json<CreatedResponse>();
    return request;
  }

  it('resolves from the product the customer named, with no order id given', async () => {
    // "fell over and broke" is not a phrase the reason table can read, so this used to
    // end as an escalation - which says nothing about order identification, the thing
    // this test is about. Said as a customer who also named the fault, so the case
    // exercises the resolution and not the intake vocabulary.
    const request = await submit({ message: 'The floor lamp I bought fell over and is broken, please refund me.' });

    expect(request.orderId).toBe(LAMP_ORDER);
  });

  it('understands a word the customer uses instead of the product name', async () => {
    // Nobody types "Aria Floor Lamp". "The lamp" has to reach the same order.
    const request = await submit({ message: 'My lamp is damaged, I would like a refund.' });

    expect(request.orderId).toBe(LAMP_ORDER);
  });

  it('picks the right order when several are in the history', async () => {
    const request = await submit({ message: 'The headphones arrived broken and I want my money back.' });

    expect(request.orderId).toBe(HEADPHONE_ORDER);
  });

  it('escalates rather than pick one when the message identifies nothing', async () => {
    const request = await submit({ message: 'I would like a refund for a purchase that went badly.' });

    expect(request.orderId).toBeNull();
    expect(request.decision.decision).toBe('escalated');
    expect(request.decision.trace.map((rule) => rule.ruleId)).toContain('R-13');
  });

  it('escalates when the words match more than one order equally', async () => {
    // "Something" and "else" name nothing specific. A tie is not a decision.
    const request = await submit({ message: 'I want to return something I bought recently and get my money back.' });

    expect(request.orderId).toBeNull();
    expect(request.decision.decision).toBe('escalated');
  });

  it('honours an order id typed inside the message', async () => {
    const request = await submit({ message: 'Please refund ORD-9102, the mug set was damaged.' });

    expect(request.orderId).toBe(MUG_ORDER);
  });

  it('refuses another customer\'s order id without confirming it exists', async () => {
    // The response must be identical whether the order belongs to someone else
    // or does not exist at all, or this endpoint becomes an order-id oracle.
    //
    // The two messages are worded differently on purpose. Identical text would
    // make the second call a duplicate of the first, and the duplicate gate
    // answers it with the earlier request - which would make the two summaries
    // match for a reason that has nothing to do with the oracle.
    const foreign = await submit({ orderId: STRANGER_ORDER, message: 'I want a refund please.' });
    const invented = await submit({ orderId: 'ORD-000000', message: 'Could I get a refund on that order?' });

    expect(foreign.orderId).toBeNull();
    expect(invented.orderId).toBeNull();
    expect(foreign.decision.summary).toBe(invented.decision.summary);
  });

  it('leaves the other customer\'s order unrefunded', async () => {
    const request = await submit({ orderId: STRANGER_ORDER, message: 'I want a full refund, damaged.' });

    expect(request.decision.refundAmountCents).toBe(0);
  });

  it('refunds only the named product, not the whole basket it arrived in', async () => {
    const request = await submit({ message: 'The floor lamp arrived cracked, I want a refund for it.' });

    expect(request.decision.decision).toBe('approved');
    expect(request.decision.refundAmountCents).toBe(30000);
  });

  it('escalates when the selected order and the described product disagree', async () => {
    const request = await submit({
      orderId: MUG_ORDER,
      message: 'The floor lamp broke.',
    });

    // The order is taken as given - the customer is looking at a specific order
    // in the UI - but the money is still scoped to what they complained about.
    expect(request.orderId).toBeNull();
    expect(request.decision.decision).toBe('escalated');
    expect(request.decision.refundAmountCents).toBe(0);
  });
});
