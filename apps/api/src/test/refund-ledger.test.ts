import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { appHarness, TEST_NOW, authHeader } from './helpers.js';
import {
  authoriseRefund,
  findRefundByIdempotencyKey,
  listRefundsForOrder,
  pendingCentsForOrder,
  releaseRefund,
  settleRefund,
  settledCentsForOrder,
  RefundLedgerError,
  type RefundRecord,
} from '../db/refundLedger.js';

/** Typed row reader, matching the one the HTTP suite uses. */
function rows<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
import { runFactGates } from '../policy/gates.js';
import { R06bRefundableBalance, refundableRemainingCents } from '../policy/rules/R-06b-refundable-balance.js';
import { findOrder } from '../db/orderRepository.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
import type { PolicyContext } from '../policy/types.js';
import { FULLY_REFUNDED } from '../policy/constants.js';

/**
 * The ledger is the only thing standing between an approval and a customer's
 * money, so these tests are about the ways it can be wrong: paying twice,
 * reserving the same money twice, paying more than was collected, and leaving a
 * reservation behind when the decision that created it is undone.
 */

interface Fixture {
  readonly db: Db;
  readonly customerId: string;
  readonly orderId: string;
  readonly totalCents: number;
}

/** The first seeded order, which is settled, inside its window, and un-refunded. */
function refundableOrder(): Fixture {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  const row = db
    .prepare(
      `SELECT o.id AS order_id, o.customer_id,
              (SELECT COALESCE(SUM(unit_price_cents * quantity), 0) FROM order_items WHERE order_id = o.id) AS total
         FROM orders o ORDER BY o.id LIMIT 1`,
    )
    .get() as { order_id: string; customer_id: string; total: number } | undefined;
  if (row === undefined) {
    throw new Error('seed produced no orders');
  }
  return { db, customerId: row.customer_id, orderId: row.order_id, totalCents: row.total };
}

const REQUEST_ID = 'REQ-LEDGER-1';

/**
 * The approved request an authorisation hangs off.
 *
 * Written directly rather than through the pipeline so the tests here are about
 * the ledger and not about whether a particular scenario approves; the wiring
 * from an HTTP approval to a pending row is proven in http.test.ts.
 */
function approvedRequestRow(fixture: Fixture, amountCents: number, requestId = REQUEST_ID): NewRequestRow {
  const at = TEST_NOW.toISOString();
  return {
    id: requestId,
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
    summary: 'fixture',
    policyRef: 'REFUND_POLICY.md §5.1',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: '[]',
    blockedItemsJson: '[]',
    responseText: 'fixture',
    extractionJson: null,
    groundingJson: null,
    injectionJson: '{"detected":false,"signals":[],"obfuscationNoted":false}',
    aiMode: 'fake',
    llmCalled: false,
    timingsJson: '[]',
    scenarioId: null,
  };
}

function authoriseFixture(fixture: Fixture, amountCents: number, requestId = REQUEST_ID): RefundRecord {
  insertRequest(fixture.db, approvedRequestRow(fixture, amountCents, requestId));
  return authoriseRefund(fixture.db, {
    requestId,
    orderId: fixture.orderId,
    customerId: fixture.customerId,
    amountCents,
    now: TEST_NOW,
  });
}

/** The policy context a gate sees for a fixture order. */
function contextFor(fixture: Fixture): PolicyContext {
  const order = findOrder(fixture.db, fixture.customerId, fixture.orderId, TEST_NOW);
  if (order === null) {
    throw new Error('order missing');
  }
  return {
    db: fixture.db,
    customer: null,
    order,
    duplicateSibling: null,
    injection: { detected: false, signals: [], obfuscationNoted: false },
    injectionAction: 'deny',
    extraction: null,
    grounding: null,
    subjectItem: null,
    eligibleItems: [],
    blockedItems: [],
    eligibleAmountCents: 0,
    orderTotalCents: order.totalCents,
  };
}

describe('the ledger reserves on approval and moves money only on settlement', () => {
  it('starts with nothing refunded and nothing reserved', () => {
    const fixture = refundableOrder();
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
    expect(pendingCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
  });

  it('holds an approved amount as pending without counting it as refunded', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);

    expect(refund.status).toBe('pending_verification');
    expect(refund.verifiedBy).toBeNull();
    // Reserved, not paid. This is the distinction the whole feature rests on.
    expect(pendingCentsForOrder(fixture.db, fixture.orderId)).toBe(5000);
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
  });

  it('leaves the order untouched until a person verifies', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);

    const before = findOrder(fixture.db, fixture.customerId, fixture.orderId, TEST_NOW);
    expect(before?.refundedCents).toBe(0);

    const settled = settleRefund(fixture.db, refund.id, 'alice', TEST_NOW);

    expect(settled.status).toBe('settled');
    expect(settled.verifiedBy).toBe('alice');
    expect(settled.settledAt).toBe(TEST_NOW.toISOString());
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(5000);
    expect(findOrder(fixture.db, fixture.customerId, fixture.orderId, TEST_NOW)?.refundedCents).toBe(5000);
  });

  it('marks the order fully refunded only when the balance reaches the total', () => {
    const fixture = refundableOrder();
    const half = Math.floor(fixture.totalCents / 2);

    settleRefund(fixture.db, authoriseFixture(fixture, half).id, 'alice', TEST_NOW);
    expect(findOrder(fixture.db, fixture.customerId, fixture.orderId, TEST_NOW)?.paymentState).toBe(
      'partially_refunded',
    );

    // A second claim for the remainder, under its own request id - and its own
    // request row, since a ledger entry that could not be traced to a decision
    // would be a payment nobody authorised.
    const second = authoriseFixture(fixture, fixture.totalCents - half, 'REQ-LEDGER-2');
    settleRefund(fixture.db, second.id, 'alice', TEST_NOW);

    const settled = findOrder(fixture.db, fixture.customerId, fixture.orderId, TEST_NOW);
    expect(settled?.refundedCents).toBe(fixture.totalCents);
    expect(settled?.paymentState).toBe(FULLY_REFUNDED);
  });
});

describe('the ledger cannot be made to pay twice', () => {
  it('authorising the same request again returns the original reservation', () => {
    const fixture = refundableOrder();
    const first = authoriseFixture(fixture, 5000);
    const second = authoriseRefund(fixture.db, {
      requestId: REQUEST_ID,
      orderId: fixture.orderId,
      customerId: fixture.customerId,
      amountCents: 5000,
      now: TEST_NOW,
    });

    expect(second.id).toBe(first.id);
    // The dangerous failure is not a duplicate row, it is a double reservation.
    expect(pendingCentsForOrder(fixture.db, fixture.orderId)).toBe(5000);
    expect(listRefundsForOrder(fixture.db, fixture.orderId)).toHaveLength(1);
  });

  it('settling the same refund twice is refused rather than repeated', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);
    settleRefund(fixture.db, refund.id, 'alice', TEST_NOW);

    expect(() => settleRefund(fixture.db, refund.id, 'bob', TEST_NOW)).toThrow(RefundLedgerError);
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(5000);
  });

  it('derives one idempotency key per authorisation so a retried payout is the same payout', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);

    // A processor retry has to be recognisable as the same transfer. The key is
    // derived from the request, so recomputing the authorisation cannot change it.
    const again = authoriseRefund(fixture.db, {
      requestId: REQUEST_ID,
      orderId: fixture.orderId,
      customerId: fixture.customerId,
      amountCents: 5000,
      now: TEST_NOW,
    });
    expect(again.idempotencyKey).toBe(refund.idempotencyKey);
    expect(findRefundByIdempotencyKey(fixture.db, refund.idempotencyKey)?.id).toBe(refund.id);
  });

  it('refuses to settle more than the order was worth', () => {
    const fixture = refundableOrder();
    // Reserved past the order total: the table cannot know the order's total, so
    // this is the layer that has to catch it.
    const refund = authoriseFixture(fixture, fixture.totalCents + 1000);

    expect(() => settleRefund(fixture.db, refund.id, 'alice', TEST_NOW)).toThrow(/more than was paid/);
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
  });

  it('will not reopen a reservation that has already been paid', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);
    settleRefund(fixture.db, refund.id, 'alice', TEST_NOW);

    // Money that has gone out cannot be re-reserved, however the request is
    // re-decided. Returning the settled row unchanged keeps this idempotent and
    // leaves the refusal to R-06/R-06b, which own the order's real state.
    const again = authoriseRefund(fixture.db, {
      requestId: REQUEST_ID,
      orderId: fixture.orderId,
      customerId: fixture.customerId,
      amountCents: 5000,
      now: TEST_NOW,
    });

    expect(again.status).toBe('settled');
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(5000);
  });

  it('refuses to settle a released reservation', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 5000);
    releaseRefund(fixture.db, refund.id, 'claim turned out to be a duplicate', TEST_NOW);

    expect(() => settleRefund(fixture.db, refund.id, 'alice', TEST_NOW)).toThrow(/nothing to pay/);
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
  });
});

describe('releasing gives the balance back', () => {
  it('returns the reserved amount to the order when an approval is undone', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, fixture.totalCents);
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(0);

    const released = releaseRefund(fixture.db, refund.id, 'customer withdrew the claim', TEST_NOW);

    expect(released.status).toBe('released');
    expect(released.releaseReason).toBe('customer withdrew the claim');
    // The customer can claim the whole order again, which is the point: a
    // reservation that outlived its decision would be a silent deduction.
    expect(pendingCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(fixture.totalCents);
  });

  it('records when a reservation was released, and who did not check it', () => {
    const fixture = refundableOrder();
    const released = releaseRefund(fixture.db, authoriseFixture(fixture, 1000).id, 'no longer eligible', TEST_NOW);

    expect(released.releasedAt).toBe(TEST_NOW.toISOString());
    // Nobody verified a payment that never happened.
    expect(released.verifiedBy).toBeNull();
  });

  it('reinstates a released reservation when the approval comes back', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, fixture.totalCents);
    releaseRefund(fixture.db, refund.id, 'customer withdrew the claim', TEST_NOW);
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(fixture.totalCents);

    // A supervisor reinstating the claim. The same reservation has to come back,
    // carrying the same idempotency key: it is the same authorisation of the same
    // request, and a new key would let a processor treat it as a second payment.
    const again = authoriseRefund(fixture.db, {
      requestId: REQUEST_ID,
      orderId: fixture.orderId,
      customerId: fixture.customerId,
      amountCents: fixture.totalCents,
      now: TEST_NOW,
    });

    expect(again.id).toBe(refund.id);
    expect(again.status).toBe('pending_verification');
    expect(again.idempotencyKey).toBe(refund.idempotencyKey);
    // Cleared, not carried: a pending row must not report a release that no
    // longer applies to it.
    expect(again.releaseReason).toBeNull();
    expect(again.releasedAt).toBeNull();
    expect(listRefundsForOrder(fixture.db, fixture.orderId)).toHaveLength(1);
  });

  it('will not release a refund twice', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, 1000);
    releaseRefund(fixture.db, refund.id, 'first', TEST_NOW);

    expect(() => releaseRefund(fixture.db, refund.id, 'second', TEST_NOW)).toThrow(/nothing pending to release/);
  });
});

describe('R-06b stops the same money being promised twice', () => {
  it('passes while the whole balance is still available', () => {
    const fixture = refundableOrder();
    expect(R06bRefundableBalance.evaluate(contextFor(fixture)).outcome).toBe('pass');
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(fixture.totalCents);
  });

  it('denies once an approval has reserved the entire balance', () => {
    const fixture = refundableOrder();
    authoriseFixture(fixture, fixture.totalCents);

    const evaluation = R06bRefundableBalance.evaluate(contextFor(fixture));

    expect(evaluation.outcome).toBe('deny');
    // The message has to name the pending money: "denied" alone sends a reviewer
    // looking for a bug instead of finding an empty balance.
    expect(evaluation.evidence).toContain('awaiting verification');
  });

  it('denies when the balance is already spent even with nothing pending', () => {
    const fixture = refundableOrder();
    // Paid out by some earlier run, with no reservation outstanding. The balance
    // is still gone, which is the case R-06 alone would not catch on its own.
    fixture.db
      .prepare('UPDATE orders SET refunded_cents = ? WHERE id = ?')
      .run(fixture.totalCents, fixture.orderId);

    expect(R06bRefundableBalance.evaluate(contextFor(fixture)).outcome).toBe('deny');
  });

  it('runs in the fact gates and can terminate a request before the model', () => {
    const fixture = refundableOrder();
    authoriseFixture(fixture, fixture.totalCents);

    const gates = runFactGates(contextFor(fixture));

    expect(gates.terminal).toBe(true);
    expect(gates.evaluations.map((entry) => entry.ruleId)).toContain('R-06b');
  });

  it('leaves the remainder refundable after a partial reservation', () => {
    const fixture = refundableOrder();
    authoriseFixture(fixture, 1000);

    // A small claim must not strand the rest of the order, or one small pending
    // refund would block a large legitimate one.
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(
      fixture.totalCents - 1000,
    );
  });
});

describe('an approval that is later denied gives the money back', () => {
  it('releases the reservation so the order stays claimable', () => {
    const fixture = refundableOrder();
    const refund = authoriseFixture(fixture, fixture.totalCents);

    // What applyOverride does when an approval becomes a denial.
    const released = releaseRefund(fixture.db, refund.id, 'override approved -> denied: not faulty', TEST_NOW);

    expect(released.status).toBe('released');
    expect(refundableRemainingCents(fixture.db, fixture.orderId, fixture.totalCents)).toBe(fixture.totalCents);
    expect(settledCentsForOrder(fixture.db, fixture.orderId)).toBe(0);
  });
});

describe('the human verification endpoints', () => {
  interface Queue {
    readonly app: FastifyInstance;
    readonly db: Db;
    readonly refundId: string;
  }

  /** An approval against the app harness's own seeded database. */
  function authoriseIn(db: Db, requestId: string, amountCents: number): RefundRecord {
    const customer = rows<{ id: string }>(db, 'SELECT id FROM customers ORDER BY id LIMIT 1')[0];
    const order = rows<{ id: string }>(db, 'SELECT id FROM orders ORDER BY id LIMIT 1')[0];
    if (customer === undefined || order === undefined) {
      throw new Error('seed produced no customer or order');
    }
    insertRequest(db, { ...approvedRequestRow({ db, customerId: customer.id, orderId: order.id, totalCents: amountCents }, amountCents), id: requestId });
    return authoriseRefund(db, {
      requestId,
      orderId: order.id,
      customerId: customer.id,
      amountCents,
      now: TEST_NOW,
    });
  }

  /** A real app over a seeded database with one approval waiting for review. */
  async function queue(): Promise<Queue> {
    const { app, db } = await appHarness();
    // appHarness owns its own database, so work against that one instead.
    return { app, db, refundId: authoriseIn(db, 'REQ-LIVE-1', 5000).id };
  }

  it('lists pending authorisations for staff to work through', async () => {
    const { app, refundId } = await queue();

    const response = await app.inject({
      method: 'GET',
      url: '/api/refunds?status=pending_verification',
      headers: { authorization: authHeader('agent') },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ refunds: { id: string; status: string; amountCents: number }[] }>();
    expect(body.refunds.map((row) => row.id)).toContain(refundId);
    expect(body.refunds[0]?.status).toBe('pending_verification');
  });

  it('refuses the queue to an unauthenticated caller', async () => {
    const { app } = await queue();
    expect((await app.inject({ method: 'GET', url: '/api/refunds' })).statusCode).toBe(401);
  });

  it('settles for an admin and records who checked it', async () => {
    const { app, db, refundId } = await queue();

    const response = await app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/settle`,
      headers: { authorization: authHeader('admin', 'alice') },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ refund: { status: string; verifiedBy: string } }>();
    expect(body.refund.status).toBe('settled');
    // From the token, so "who checked this" is an answer rather than a claim.
    expect(body.refund.verifiedBy).toBe('alice');

    const orderId = rows<{ id: string }>(db, 'SELECT id FROM orders ORDER BY id LIMIT 1')[0]?.id ?? '';
    expect(settledCentsForOrder(db, orderId)).toBe(5000);
    const audit = rows<{ detail: string }>(db, "SELECT detail FROM audit_events WHERE kind = 'refund_settled'");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toContain('5000 cents settled');
  });

  it('keeps settlement above an ordinary agent', async () => {
    const { app, refundId } = await queue();

    const response = await app.inject({
      method: 'POST',
      url: `/api/refunds/${refundId}/settle`,
      headers: { authorization: authHeader('agent') },
      payload: {},
    });

    // Approving a refund is a policy call the pipeline makes on its own; issuing
    // one spends the company's money, so it cannot be an agent's button.
    expect(response.statusCode).toBe(403);
  });

  it('answers a repeated settle with a conflict, not a second payment', async () => {
    const { app, db, refundId } = await queue();
    const settle = {
      method: 'POST' as const,
      url: `/api/refunds/${refundId}/settle`,
      headers: { authorization: authHeader('admin') },
      payload: {},
    };

    expect((await app.inject(settle)).statusCode).toBe(200);
    const second = await app.inject(settle);

    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe('refund_conflict');
    const orderId = rows<{ id: string }>(db, 'SELECT id FROM orders ORDER BY id LIMIT 1')[0]?.id ?? '';
    expect(settledCentsForOrder(db, orderId)).toBe(5000);
  });

  it('requires a reason to release a reservation', async () => {
    const { app, refundId } = await queue();
    const release = (reason: string) => ({
      method: 'POST' as const,
      url: `/api/refunds/${refundId}/release`,
      headers: { authorization: authHeader('admin') },
      payload: { reason },
    });

    // Releasing money back without saying why is as unaccountable as paying it
    // without a reviewer, so the blank reason is refused.
    expect((await app.inject(release('   '))).statusCode).toBe(400);
    const good = await app.inject(release('duplicate of an earlier claim'));
    expect(good.statusCode).toBe(200);
    expect(good.json<{ refund: { status: string } }>().refund.status).toBe('released');
  });

  it('404s a refund that does not exist', async () => {
    const { app } = await queue();
    const response = await app.inject({
      method: 'POST',
      url: '/api/refunds/RFD-nope/settle',
      headers: { authorization: authHeader('admin') },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports the acting identity from the token', async () => {
    const { app } = await queue();
    const response = await app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: { authorization: authHeader('agent', 'bob') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ subject: string; role: string }>()).toMatchObject({ subject: 'bob', role: 'agent' });
  });
});
