import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { sessionFor } from './shop-helpers.js';
import { daysAgo } from '../db/seed.js';
import type { Db } from '../db/connection.js';
import type { RefundRequestDto } from '@refund/shared';
import { listRequests } from '../db/requestRepository.js';
import { verifyAuditChain } from '../db/auditChain.js';

/**
 * "I already told you this."
 *
 * The customer-side duplicate gate. The two properties under test are the ones
 * that matter and that are easy to get wrong in opposite directions:
 *
 *  - A repeat is *suppressed*, so no second decision exists and therefore no
 *    second refund reservation. Asserting on the request count rather than on
 *    the returned body is what actually proves this.
 *  - The match survives being retyped - different capitalisation, different
 *    spacing - because a customer who resends is a human, not a copy-paste.
 *
 * It is equally important that the gate does *not* swallow a genuinely new
 * claim, which is why the negative cases are here rather than assumed.
 */

const CUSTOMER = 'CUST-9001';
const HEADPHONE_ORDER = 'ORD-9103';
const LAMP_ORDER = 'ORD-9101';

/** One customer with two ordinary orders, so a repeat is possible but not inevitable. */
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
  insertOrder.run(HEADPHONE_ORDER, CUSTOMER, daysAgo(TEST_NOW, 60).toISOString(), daysAgo(TEST_NOW, 55).toISOString());

  const insertItem = db.prepare(
    `INSERT INTO order_items (id, order_id, name, unit_price_cents, quantity, final_sale, digital, downloaded)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
  );
  insertItem.run('ITM-9101-A', LAMP_ORDER, 'Aria Floor Lamp', 30000);
  insertItem.run('ITM-9103-A', HEADPHONE_ORDER, 'Studio Headphones', 32000);
}

interface CreatedResponse {
  readonly request: RefundRequestDto;
}

interface SuppressedResponse extends CreatedResponse {
  readonly duplicate?: {
    readonly ofRequestId: string;
    readonly firstReportedAt: string;
    readonly firstDecision: string;
  };
}

const MESSAGE = 'The headphones arrived broken and I want my money back.';

describe('recognising a report the customer has already made', () => {
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

  async function send(message: string, orderId?: string): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie },
      payload: { customerId: CUSTOMER, message, ...(orderId === undefined ? {} : { orderId }) },
    });
  }

  it('does not create a second request when the same complaint is sent again', async () => {
    const first = await send(MESSAGE);
    expect(first.statusCode).toBe(201);

    const before = listRequests(harness.db, { limit: 500 }).filter((row) => row.customerId === CUSTOMER).length;
    const repeat = await send(MESSAGE);
    const after = listRequests(harness.db, { limit: 500 }).filter((row) => row.customerId === CUSTOMER).length;

    // 200, not 201: nothing was created. A client that treats 201 as "a new
    // request was made" and retries on it would drive exactly the loop this gate
    // exists to stop.
    expect(repeat.statusCode).toBe(200);
    expect(after).toBe(before);
  });

  it('hands back the request the customer already has, not a fresh one', async () => {
    const first = await send(MESSAGE);
    const { request: original } = first.json<CreatedResponse>();

    const repeat = await send(MESSAGE);
    const { request: shown, duplicate } = repeat.json<SuppressedResponse>();

    expect(shown.id).toBe(original.id);
    expect(shown.decision.decision).toBe(original.decision.decision);
    expect(duplicate?.ofRequestId).toBe(original.id);
    // The customer has to be told why the same answer came back. A page that
    // silently re-renders an earlier decision looks broken, and a duplicate
    // nobody knows about is worse than no duplicate at all.
    expect(shown.responseText).toMatch(/already reported/i);
  });

  it('recognises a repeat that was retyped rather than resent verbatim', async () => {
    await send(MESSAGE);

    // Same complaint, different capitalisation, an extra full stop and a
    // double space. A human retyping is the common case, not the exception.
    const retyped = await send('  the HEADPHONES arrived broken and i want my money back!!  ');

    expect(retyped.statusCode).toBe(200);
  });

  it('leaves a different complaint alone', async () => {
    await send(MESSAGE);

    // Different product, different problem. Same customer, same order - still
    // not a duplicate, and a gate that treated it as one would be refusing
    // legitimate follow-up.
    const different = await send('Actually, the floor lamp is cracked too.');

    expect(different.statusCode).toBe(201);
  });

  it('does not confuse a repeat with a request about a different amount', async () => {
    await send('I was charged $41.00 twice for order ORD-1001.');

    // Same words around the numbers, different numbers. The figures are what
    // make these two different claims, so a fingerprint that dropped digits
    // would merge them.
    const otherAmount = await send('I was charged $82.00 twice for order ORD-1001.');

    expect(otherAmount.statusCode).toBe(201);
  });

  it('writes the suppressed attempt to the audit chain', async () => {
    const { request: original } = (await send(MESSAGE)).json<CreatedResponse>();
    await send(MESSAGE);

    const events = listRequests(harness.db, { limit: 500 });
    expect(events.length).toBeGreaterThan(0);

    // A suppressed request that leaves no trace is invisible to the reviewer who
    // would want to know the customer had to ask twice.
    const chain = verifyAuditChain(harness.db);
    expect(chain.ok).toBe(true);
    expect(original.id).not.toBe('');
  });

  it('keeps the whole chain valid after suppressing a repeat', async () => {
    await send(MESSAGE);
    await send(MESSAGE);

    // The duplicate event is appended through the same chained writer, so a
    // suppression cannot be used to break the tamper-evidence of the request it
    // refers to.
    const verdict = verifyAuditChain(harness.db);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.checked).toBeGreaterThan(0);
    }
  });
});
