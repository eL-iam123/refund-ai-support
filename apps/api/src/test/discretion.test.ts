import { describe, expect, it } from 'vitest';
import type { ClaimExtraction, GroundingResult, RuleEvaluation } from '@refund/shared';
import type { DiscretionConfig } from '../config/env.js';
import type { CustomerRecord, OrderRecord } from '../db/records.js';
import {
  recommendDiscretion,
  DEFAULT_DISCRETION,
  type DiscretionContext,
} from '../policy/discretion.js';

/**
 * The discretion layer in isolation.
 *
 * Each rule is tested against the bound that governs it, so a test fails on the
 * rule that regressed rather than on a downstream consequence. The contexts are
 * minimal: only the fields a rule reads are set, which is also the documentation
 * of what each rule is allowed to look at.
 */

const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  id: 'ORD-1',
  customerId: 'CUST-1',
  placedAt: new Date('2026-01-01T00:00:00.000Z'),
  deliveredAt: new Date('2026-01-05T00:00:00.000Z'),
  ageDays: 10,
  status: 'delivered',
  paymentState: 'settled',
  refundedCents: 0,
  totalCents: 10000,
  isSubscription: false,
  trackingStatus: 'delivered',
  signedByCustomer: true,
  conditionAtDelivery: null,
  items: [{ id: 'I1', name: 'Mug', unitPriceCents: 10000, quantity: 1, finalSale: false, digital: false, downloaded: false, isSubscription: false }],
  ...over,
});

const customer = (over: Partial<CustomerRecord> = {}): CustomerRecord => ({
  id: 'CUST-1',
  name: 'Pat',
  email: 'pat@example.com',
  tier: 'standard',
  accountCreatedAt: new Date('2020-01-01T00:00:00.000Z'),
  accountAgeDays: 2000,
  priorRefundCount: 0,
  refundRequestsLast30Days: 0,
  ...over,
});

const extraction = (over: Partial<ClaimExtraction> = {}): ClaimExtraction => ({
  intent: 'refund',
  reason: 'damaged',
  condition: 'damaged',
  confidence: 0.9,
  orderRef: null,
  claimedAmountCents: null,
  items: [],
  evidenceQuotes: ['the mug arrived cracked'],
  language: 'en',
  urgency: 'normal',
  policyOverrideAttempted: false,
  ...over,
});

const GROUNDING_FAULT: GroundingResult = {
  grounded: true,
  verifiedQuotes: ['the mug arrived cracked'],
  rejectedQuotes: [],
};

const GROUNDING_NONE: GroundingResult = {
  grounded: false,
  verifiedQuotes: [],
  rejectedQuotes: ['the mug arrived cracked'],
};

const escalation = (ruleId: string): RuleEvaluation => ({
  ruleId: ruleId as RuleEvaluation['ruleId'],
  ruleClass: 'approval-authority',
  scope: 'order',
  outcome: 'escalate',
  evidence: `${ruleId} escalated`,
  policyRef: 'REFUND_POLICY.md §3.1',
  itemIds: [],
});

function context(over: Partial<DiscretionContext> = {}): DiscretionContext {
  return {
    baseDecision: 'escalated',
    winner: escalation('R-03'),
    trace: [escalation('R-03')],
    order: order(),
    customer: customer(),
    eligibleAmountCents: 10000,
    orderTotalCents: 10000,
    extraction: extraction(),
    grounding: GROUNDING_FAULT,
    config: { ...DEFAULT_DISCRETION, enabled: true },
    ...over,
  };
}

const config = (over: Partial<DiscretionConfig> = {}): DiscretionConfig => ({
  ...DEFAULT_DISCRETION,
  enabled: true,
  ...over,
});

describe('discretion is off by default', () => {
  it('returns none when disabled, even for a case that would qualify', () => {
    const result = recommendDiscretion(context({ config: config({ enabled: false }) }));
    expect(result.kind).toBe('none');
  });

  it('returns none when the base decision is not an escalation', () => {
    const result = recommendDiscretion(context({ baseDecision: 'denied' }));
    expect(result.kind).toBe('none');
  });

  it('returns none when there is no order or nothing eligible', () => {
    expect(recommendDiscretion(context({ order: null })).kind).toBe('none');
    expect(recommendDiscretion(context({ eligibleAmountCents: 0 })).kind).toBe('none');
  });
});

describe('courtesy window', () => {
  // The eligible amount is held above the low-value cap so that only the courtesy
  // rule can fire; otherwise the low-value rule would approve these regardless.
  const isolated = { eligibleAmountCents: 80000, config: config({ maxAmountCents: 50000, allowPartial: false }) };

  it('approves a grounded fault within the courtesy window', () => {
    const result = recommendDiscretion(
      context({
        ...isolated,
        winner: escalation('R-01b'),
        trace: [escalation('R-01b')],
        order: order({ ageDays: 40 }),
        config: config({ maxAmountCents: 50000, maxAgeDays: 45, allowPartial: false }),
      }),
    );
    expect(result.kind).toBe('approve');
  });

  it('does not approve past the courtesy window', () => {
    const result = recommendDiscretion(
      context({
        ...isolated,
        winner: escalation('R-01b'),
        trace: [escalation('R-01b')],
        order: order({ ageDays: 60 }),
        config: config({ maxAmountCents: 50000, maxAgeDays: 45, allowPartial: false }),
      }),
    );
    expect(result.kind).toBe('none');
  });

  it('does not approve without a grounded fault', () => {
    const result = recommendDiscretion(
      context({
        ...isolated,
        winner: escalation('R-01b'),
        trace: [escalation('R-01b')],
        order: order({ ageDays: 40 }),
        grounding: GROUNDING_NONE,
        config: config({ maxAmountCents: 50000, maxAgeDays: 45, allowPartial: false }),
      }),
    );
    expect(result.kind).toBe('none');
  });
});

describe('loyalty', () => {
  // The eligible amount sits between the low-value cap and the loyalty cap, so the
  // low-value rule cannot fire and only loyalty can distinguish the two members.
  const isolated = {
    eligibleAmountCents: 80000,
    config: config({ maxAmountCents: 50000, loyaltyMaxAmountCents: 150000, allowPartial: false }),
  };

  it('approves a plus member within the loyalty cap', () => {
    const result = recommendDiscretion(
      context({ ...isolated, customer: customer({ tier: 'plus' }) }),
    );
    expect(result.kind).toBe('approve');
  });

  it('does not approve a standard member on loyalty alone', () => {
    const result = recommendDiscretion(
      context({ ...isolated, customer: customer({ tier: 'standard' }) }),
    );
    expect(result.kind).toBe('none');
  });

  it('does not approve a plus member past the loyalty cap', () => {
    const result = recommendDiscretion(
      context({
        ...isolated,
        eligibleAmountCents: 200000,
        customer: customer({ tier: 'plus' }),
      }),
    );
    expect(result.kind).toBe('none');
  });
});

describe('low-value auto-approve', () => {
  it('approves a small grounded claim', () => {
    const result = recommendDiscretion(
      context({ eligibleAmountCents: 10000, config: config({ maxAmountCents: 50000 }) }),
    );
    expect(result.kind).toBe('approve');
  });

  it('does not approve a claim above the pre-authorised amount on this rule', () => {
    const result = recommendDiscretion(
      context({ eligibleAmountCents: 80000, config: config({ maxAmountCents: 50000 }) }),
    );
    expect(result.kind).not.toBe('approve');
  });
});

describe('partial refund', () => {
  it('approves a partial amount for a large grounded claim when enabled', () => {
    const result = recommendDiscretion(
      context({
        eligibleAmountCents: 80000,
        config: config({ maxAmountCents: 50000, allowPartial: true }),
      }),
    );
    expect(result).toEqual({ kind: 'partial_refund', amountCents: 50000 });
  });

  it('does not offer a partial refund when disabled', () => {
    const result = recommendDiscretion(
      context({
        eligibleAmountCents: 80000,
        config: config({ maxAmountCents: 50000, allowPartial: false }),
      }),
    );
    expect(result.kind).not.toBe('partial_refund');
  });
});

describe('alternatives', () => {
  it('offers an exchange for a plausible non-fault claim when enabled', () => {
    const result = recommendDiscretion(
      context({
        extraction: extraction({ reason: 'changed_mind' }),
        grounding: GROUNDING_NONE,
        config: config({ allowExchange: true }),
      }),
    );
    expect(result.kind).toBe('exchange');
  });

  it('offers store credit when exchange is disabled', () => {
    const result = recommendDiscretion(
      context({
        extraction: extraction({ reason: 'changed_mind' }),
        grounding: GROUNDING_NONE,
        config: config({ allowExchange: false, allowStoreCredit: true }),
      }),
    );
    expect(result.kind).toBe('store_credit');
  });

  it('offers nothing when both alternatives are disabled', () => {
    const result = recommendDiscretion(
      context({
        extraction: extraction({ reason: 'changed_mind' }),
        grounding: GROUNDING_NONE,
        config: config({ allowExchange: false, allowStoreCredit: false }),
      }),
    );
    expect(result.kind).toBe('none');
  });
});

describe('near-miss quote', () => {
  it('does not fire when disabled', () => {
    const result = recommendDiscretion(
      context({
        grounding: GROUNDING_NONE,
        config: config({ nearMissQuote: false, minConfidence: 0.5 }),
      }),
    );
    expect(result.kind).toBe('none');
  });

  it('does not fire below the confidence floor', () => {
    const result = recommendDiscretion(
      context({
        extraction: extraction({ confidence: 0.2 }),
        grounding: GROUNDING_NONE,
        config: config({ nearMissQuote: true, minConfidence: 0.5 }),
      }),
    );
    expect(result.kind).toBe('none');
  });
});

describe('discretion never overrides a denial', () => {
  it('returns none for a denied base decision regardless of the config', () => {
    const result = recommendDiscretion(
      context({
        baseDecision: 'denied',
        config: config({ maxAmountCents: 500000, allowPartial: true, allowExchange: true, allowStoreCredit: true }),
      }),
    );
    expect(result.kind).toBe('none');
  });
});

describe('a request that escalated for a person is never softened', () => {
  /**
   * The escalation reason is what the rules recorded, and risk and integrity are
   * the classes that exist because the request must not be settled automatically.
   * A small, well-evidenced claim on such an order is exactly the shape an
   * abuser's claim takes, so paying it because the amount is small turns the risk
   * rule off - which is what happened: an order with an open chargeback was
   * approved and paid.
   */
  it.each(['R-07', 'R-08', 'R-09', 'R-14'])('offers nothing when %s escalated', (ruleId) => {
    const personOnly = {
      ruleId: ruleId as RuleEvaluation['ruleId'],
      ruleClass: ruleId === 'R-14' ? ('integrity' as const) : ('risk' as const),
      scope: 'order' as const,
      outcome: 'escalate' as const,
      evidence: `${ruleId} escalated`,
      policyRef: 'REFUND_POLICY.md §6',
      itemIds: [],
    };

    for (const bounds of [
      {},
      { allowPartial: true },
      { allowExchange: true },
      { allowStoreCredit: true },
      { maxAmountCents: 1_000_000, loyaltyMaxAmountCents: 1_000_000 },
    ]) {
      const result = recommendDiscretion(
        context({
          trace: [personOnly],
          winner: personOnly,
          extraction: extraction({ reason: 'damaged' }),
          grounding: GROUNDING_FAULT,
          config: config(bounds),
        }),
      );
      expect(result.kind, `${ruleId} ${JSON.stringify(bounds)}`).toBe('none');
    }
  });

  it('still softens an escalation raised by the policy on a boundary question', () => {
    // The contrast that makes the guard meaningful: an authority escalation is a
    // rule drawing a line around money, which is what an operator can authorise
    // discretion over. Only risk and integrity are excluded.
    const authority = {
      ruleId: 'R-03' as RuleEvaluation['ruleId'],
      ruleClass: 'approval-authority' as const,
      scope: 'order' as const,
      outcome: 'escalate' as const,
      evidence: 'order total above the review threshold',
      policyRef: 'REFUND_POLICY.md §5.1',
      itemIds: [],
    };

    expect(
      recommendDiscretion(
        context({
          trace: [authority],
          winner: authority,
          extraction: extraction({ reason: 'damaged' }),
          grounding: GROUNDING_FAULT,
          config: config({}),
        }),
      ).kind,
    ).toBe('approve');
  });

  it('does not turn a qualifying fault into an exchange because it was expensive', () => {
    // The customer asked about a damaged item. The choices are a larger or smaller
    // refund, not a different remedy, and an automatic exchange would resolve a
    // genuine fault with something nobody asked for.
    const authority = {
      ruleId: 'R-03' as RuleEvaluation['ruleId'],
      ruleClass: 'approval-authority' as const,
      scope: 'order' as const,
      outcome: 'escalate' as const,
      evidence: 'order total above the review threshold',
      policyRef: 'REFUND_POLICY.md §5.1',
      itemIds: [],
    };

    const result = recommendDiscretion(
      context({
        trace: [authority],
        winner: authority,
        eligibleAmountCents: 400_000,
        extraction: extraction({ reason: 'damaged' }),
        grounding: GROUNDING_FAULT,
        config: config({ allowExchange: true, allowPartial: false, maxAmountCents: 5_000 }),
      }),
    );

    expect(result.kind).toBe('none');
  });
});
