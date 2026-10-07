import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { runFactGates } from '../policy/gates.js';
import { composeDeterministicResponse } from '../response/compose.js';
import { findCustomer } from '../db/sql.js';
import { findOrder } from '../db/orderRepository.js';
import type { OrderRecord } from '../db/records.js';
import type { RefundDecision, RuleEvaluation } from '@refund/shared';
import { decided, scenarioHarness, TEST_NOW } from './helpers.js';

/**
 * A subscription line is not a reason to refuse the rest of the basket.
 *
 * R-10 used to read `orders.is_subscription`, which checkout sets as soon as
 * *any* line is a recurring charge. One monthly coffee plan on an order therefore
 * refused the coat and the mug that were on it - a denial the customer could not
 * understand, because nothing about a coat makes it a subscription. The rule is
 * now item-scoped, like final-sale, and this file holds that in place at three
 * levels: the gate, the whole pipeline, and the sentence the customer reads.
 */

const COFFEE = 'PRD-COFFEE-01';
const MUG = 'PRD-MUG-01';

describe('R-10 is item-scoped', () => {
  it('excludes the subscription line and leaves the rest of the basket eligible', () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(db, { email: 'sub@shop.test', password: 'a-good-password', name: 'Sub Tester' }, TEST_NOW);
    const placed = checkout(
      db,
      user.customerId,
      [
        { productId: COFFEE, quantity: 1 },
        { productId: MUG, quantity: 1 },
      ],
      TEST_NOW,
    );

    const order = findOrder(db, user.customerId, placed.id, TEST_NOW);
    const customer = findCustomer(db, user.customerId, TEST_NOW);
    if (order === null || customer === null) {
      throw new Error('fixture missing');
    }

    const gates = runFactGates(context(db, customer, order));

    expect(gates.blockedItems.map((item) => item.name)).toEqual(['Coffee Subscription (monthly)']);
    expect(gates.eligibleItems.map((item) => item.name)).toEqual(['Harbour Stoneware Mug']);
    const mug = order.items.find((item) => item.name === 'Harbour Stoneware Mug');
    if (mug === undefined) {
      throw new Error('fixture order has no mug');
    }
    expect(gates.eligibleAmountCents).toBe(mug.unitPriceCents);
  });

  it('does not terminate the request while something else is eligible', () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(db, { email: 'sub2@shop.test', password: 'a-good-password', name: 'Sub Two' }, TEST_NOW);
    const placed = checkout(
      db,
      user.customerId,
      [
        { productId: COFFEE, quantity: 1 },
        { productId: MUG, quantity: 1 },
      ],
      TEST_NOW,
    );

    const order = findOrder(db, user.customerId, placed.id, TEST_NOW);
    const customer = findCustomer(db, user.customerId, TEST_NOW);
    if (order === null || customer === null) {
      throw new Error('fixture missing');
    }

    // The basket carries `is_subscription = 1`, which is exactly the flag the old
    // order-scoped rule read. It must no longer be enough to end the request.
    expect(order.isSubscription).toBe(true);
    expect(runFactGates(context(db, customer, order)).terminal).toBe(false);
  });

  it('still terminates when the subscription is the whole order', () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(db, { email: 'sub3@shop.test', password: 'a-good-password', name: 'Sub Three' }, TEST_NOW);
    const placed = checkout(db, user.customerId, [{ productId: COFFEE, quantity: 1 }], TEST_NOW);

    const order = findOrder(db, user.customerId, placed.id, TEST_NOW);
    const customer = findCustomer(db, user.customerId, TEST_NOW);
    if (order === null || customer === null) {
      throw new Error('fixture missing');
    }

    const gates = runFactGates(context(db, customer, order));

    expect(gates.terminal).toBe(true);
    expect(gates.decidingRuleId).toBe('R-10');
  });
});

describe('a mixed basket is not refused for its subscription line', () => {
  it('runs the ordinary pipeline instead of denying the order', async () => {
    const h = scenarioHarness();
    seedShop(h.db, TEST_NOW);
    const user = createUser(
      h.db,
      { email: 'mixed@shop.test', password: 'a-good-password', name: 'Mixed Basket' },
      TEST_NOW,
    );
    const placed = checkout(
      h.db,
      user.customerId,
      [
        { productId: COFFEE, quantity: 1 },
        { productId: MUG, quantity: 1 },
      ],
      TEST_NOW,
    );

    // A whole-basket claim on a two-line order is ambiguous, and ambiguity is a
    // question rather than an escalation. The whole sequence matters here, because it
    // is the customer-facing defect this test now pins: ask which line, accept the
    // customer's answer, then ask for the one thing still missing. Asking which line
    // a second time - after they had just named it - would be the reported bug.
    const asked = await h.run({
      customerId: user.customerId,
      orderId: placed.id,
      message: 'the coffee subscription is on this order and I would like a refund',
    });
    expect(asked.stage).toBe('asked');

    const mugItemId = placed.items.find((item) => item.name !== 'Coffee Subscription (monthly)')?.itemId ?? '';

    // The customer's answer, sent as their own `itemIds` exactly as the storefront's
    // picker does. The next question must be about the fault, not the line.
    const askedAgain = await h.run({
      customerId: user.customerId,
      orderId: placed.id,
      itemIds: [mugItemId],
      message: 'It is about the mug.',
    });
    expect(askedAgain.stage).toBe('asked');
    expect(askedAgain.stage === 'asked' ? askedAgain.question : '').toMatch(/what has gone wrong/i);
    expect(askedAgain.stage === 'asked' ? askedAgain.question : '').not.toMatch(/or a different one/i);

    // Then the fault itself, which is the last thing the conversation needed.
    const result = decided(
      await h.run({
        customerId: user.customerId,
        orderId: placed.id,
        itemIds: [mugItemId],
        message: 'The handle is cracked, please refund me.',
      }),
    );

    expect(result.decision.decision).not.toBe('denied');
    expect(result.decision.trace.find((rule) => rule.ruleId === 'R-10')?.outcome).toBe('deny');
    expect(result.decision.blockedItems.map((item) => item.name)).toEqual([
      'Coffee Subscription (monthly)',
    ]);
  });

  it('refunds only the ticked line when the customer points at the mug', async () => {
    // The end the earlier item-scope tests could not reach: a whole-basket claim
    // on this order includes the coffee plan, so R-10 blocks a line and the
    // approval is for the rest. Tick the mug and the claim is the mug alone - the
    // subscription line is then not even in scope, and the refund is the mug.
    const h = scenarioHarness();
    seedShop(h.db, TEST_NOW);
    const user = createUser(
      h.db,
      { email: 'ticked@shop.test', password: 'a-good-password', name: 'Ticked Basket' },
      TEST_NOW,
    );
    const placed = checkout(
      h.db,
      user.customerId,
      [
        { productId: COFFEE, quantity: 1 },
        { productId: MUG, quantity: 1 },
      ],
      TEST_NOW,
    );
    const mugItemId = placed.items.find((item) => item.name !== 'Coffee Subscription (monthly)')?.itemId;
    if (mugItemId === undefined) {
      throw new Error('fixture order has no non-subscription line');
    }

    const result = decided(
      await h.run({
        customerId: user.customerId,
        orderId: placed.id,
        message: 'the mug arrived broken, please refund me',
        itemIds: [mugItemId],
      }),
    );

    expect(result.decision.decision).toBe('approved');
    expect(result.decision.refundAmountCents).toBe(
      placed.items.find((item) => item.itemId === mugItemId)?.unitPriceCents ?? 0,
    );

    // R-10 still blocks the subscription line. Eligibility is a property of the
    // basket, not of the claim, and reporting it costs nothing here because the
    // approved amount is the ticked line - a block the customer never claimed
    // cannot inflate a refund.
    expect(result.decision.blockedItems.map((item) => item.name)).toEqual([
      'Coffee Subscription (monthly)',
    ]);
  });
});

describe('a denial names the reason it gave', () => {
  const blocked = [
    { itemId: 'ITM-COAT', name: 'Meridian Wool Coat', priceCents: 24800, ruleId: 'R-02' as const, reason: 'final sale' },
  ];

  /** The bug this pins: an order-scoped refusal quoting an item rule as its reason. */
  const orderScopedDenial = decision({
    decision: 'denied',
    blockedItems: blocked,
    trace: [evaluation('R-02', 'item'), evaluation('R-10', 'order')],
  });

  it('does not blame an unrelated item when a rule refused the whole order', () => {
    const text = composeDeterministicResponse(orderScopedDenial, null, 'refund my order');

    expect(text).toContain('not able to refund');
    expect(text).not.toContain('Meridian Wool Coat');
  });

  it('does name the items when they are what made the order ineligible', () => {
    const text = composeDeterministicResponse(
      decision({ decision: 'denied', blockedItems: blocked, trace: [evaluation('R-02', 'item')] }),
      null,
      'refund my order',
    );

    expect(text).toContain('Meridian Wool Coat');
    expect(text).toContain('not eligible');
  });

  it('still names excluded items on an approval, where they are not the reason', () => {
    const text = composeDeterministicResponse(
      decision({ decision: 'approved', refundAmountCents: 20000, blockedItems: blocked, trace: [evaluation('R-02', 'item')] }),
      null,
      'the frother arrived damaged',
    );

    expect(text).toContain('approved');
    expect(text).toContain('Meridian Wool Coat');
  });
});

function evaluation(ruleId: RuleEvaluation['ruleId'], scope: RuleEvaluation['scope']): RuleEvaluation {
  return {
    ruleId,
    ruleClass: 'eligibility',
    scope,
    outcome: 'deny',
    evidence: 'fixture',
    policyRef: 'REFUND_POLICY.md §2.1',
    itemIds: scope === 'item' ? ['ITM-COAT'] : [],
  };
}

function decision(over: Partial<RefundDecision> & Pick<RefundDecision, 'decision'>): RefundDecision {
  return {
    refundAmountCents: 0,
    eligibleAmountCents: 0,
    currency: 'USD',
    summary: '',
    policyRef: '',
    trace: [],
    overrides: [],
    eligibleItemIds: [],
    blockedItems: [],
    outstandingAmountCents: 0,
    outstandingState: 'none',
    ...over,
  };
}

function context(db: ReturnType<typeof openMemoryDatabase>, customer: NonNullable<ReturnType<typeof findCustomer>>, order: OrderRecord) {
  return {
    db,
    customer,
    order,
    duplicateSibling: null,
    injection: { detected: false, signals: [], obfuscationNoted: false },
    injectionAction: 'deny' as const,
    extraction: null,
    grounding: null,
    subjectItem: null,
    eligibleItems: [] as const,
    blockedItems: [] as const,
    eligibleAmountCents: 0,
    orderTotalCents: order.totalCents,
  };
}