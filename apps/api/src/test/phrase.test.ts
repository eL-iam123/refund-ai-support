import { describe, expect, it } from 'vitest';
import type { RefundDecision } from '@refund/shared';
import { buildPhraseEnvelope } from '../response/envelope.js';
import { PHRASE_SYSTEM, buildPhraseUser } from '../ai/prompts.js';
import { isSafePhrasedReply } from '../ai/replyGuard.js';
import type { PhraseEnvelope } from '../ai/analyzer.js';
import type { OrderRecord } from '../db/records.js';
import { processRefundRequest, DEFAULT_DISCRETION } from '../orchestrator.js';
import type { PipelineDeps } from '../orchestrator.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { openMemoryDatabase } from '../db/connection.js';
import type { Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { TEST_NOW } from './helpers.js';
import type { AIAnalyzer, AttemptObserver, IntakeInput, IntakeReply, PhraseInput } from '../ai/analyzer.js';
import type { ClaimExtraction } from '@refund/shared';

/**
 * The writer half of the reader/writer split.
 *
 * The envelope is closed before any prose exists; the validator checks the
 * prose against that envelope and nothing else. So this file pins both halves
 * separately: what the envelope may contain for each outcome, and the exact
 * sentences the validator accepts or rejects. A case here is a claim about
 * the guarantee itself, not about wording taste.
 */

function mugOrder(): OrderRecord {
  return {
    id: 'ORD-TEST',
    customerId: 'CUST-TEST',
    placedAt: new Date('2026-01-01T00:00:00.000Z'),
    deliveredAt: new Date('2026-01-05T00:00:00.000Z'),
    ageDays: 9,
    status: 'delivered',
    paymentState: 'settled',
    refundedCents: 0,
    totalCents: 2400,
    isSubscription: false,
    trackingStatus: 'delivered',
    signedByCustomer: true,
    conditionAtDelivery: null,
    items: [
      {
        id: 'ITM-1',
        name: 'Harbour Stoneware Mug',
        unitPriceCents: 2400,
        quantity: 1,
        finalSale: false,
        digital: false,
        downloaded: false,
        isSubscription: false,
      },
    ],
  };
}

function decided(partial: Partial<RefundDecision>): RefundDecision {
  return {
    decision: 'approved',
    refundAmountCents: 2400,
    eligibleAmountCents: 2400,
    currency: 'USD',
    summary: 'Faulty goods: the mug arrived damaged.',
    policyRef: 'REFUND_POLICY.md §5.1',
    trace: [],
    overrides: [],
    eligibleItemIds: ['ITM-1'],
    refundItemIds: ['ITM-1'],
    blockedItems: [],
    outstandingAmountCents: 0,
    outstandingState: 'none',
    ...partial,
  };
}

describe('buildPhraseEnvelope', () => {
  it('renders whole-dollar amounts in both allowed forms', () => {
    const envelope = buildPhraseEnvelope(decided({}), mugOrder());
    expect(envelope.allowedAmounts).toEqual(['$24', '$24.00']);
    expect(envelope.itemNames).toEqual(['Harbour Stoneware Mug']);
    expect(envelope.outcome).toBe('approved');
  });

  it('renders cent amounts only in full', () => {
    const envelope = buildPhraseEnvelope(decided({ refundAmountCents: 2499, eligibleAmountCents: 2499 }), mugOrder());
    expect(envelope.allowedAmounts).toEqual(['$24.99']);
  });

  it('allows no figure on a denial and still requires the review line', () => {
    const envelope = buildPhraseEnvelope(decided({ decision: 'denied', refundAmountCents: 0 }), mugOrder());
    expect(envelope.allowedAmounts).toEqual([]);
    expect(envelope.mustSay).toEqual(['Reply to this message and a person will review it.']);
  });

  it('requires the wait and the nothing-further line on escalation', () => {
    const envelope = buildPhraseEnvelope(decided({ decision: 'escalated', refundAmountCents: 0 }), mugOrder());
    expect(envelope.mustSay).toEqual([
      'Because it needs a person to decide rather than a rule.',
      'A person will reply within one business day.',
      'Nothing further is needed from you.',
    ]);
  });

  it('names the deciding rule’s reason on escalation', () => {
    const r12: RefundDecision['trace'][number] = {
      ruleId: 'R-12',
      ruleClass: 'approval-authority',
      scope: 'order',
      outcome: 'escalate',
      evidence: 'no evidence in the message supports a reason',
      policyRef: 'REFUND_POLICY.md §5.3',
      itemIds: [],
    };
    const envelope = buildPhraseEnvelope(
      decided({ decision: 'escalated', refundAmountCents: 0, trace: [r12] }),
      mugOrder(),
    );
    expect(envelope.mustSay[0]).toBe(
      'Because we could not read the detail of your message well enough to decide it ourselves.',
    );
  });

  it('drops unknown item ids and dedupes names', () => {
    const envelope = buildPhraseEnvelope(decided({ eligibleItemIds: ['ITM-1', 'ITM-NOPE', 'ITM-1'] }), mugOrder());
    expect(envelope.itemNames).toEqual(['Harbour Stoneware Mug']);
  });

  it('names nothing when there is no order', () => {
    const envelope = buildPhraseEnvelope(decided({}), null);
    expect(envelope.itemNames).toEqual([]);
  });
});

describe('isSafePhrasedReply', () => {
  const approved: PhraseEnvelope = {
    outcome: 'approved',
    amountCents: 2400,
    allowedAmounts: ['$24', '$24.00'],
    itemNames: ['Harbour Stoneware Mug'],
    reasonSummary: 'Faulty goods: the mug arrived damaged.',
    mustSay: ['It will go back to your original payment method once a team member has checked it.'],
  };

  it('accepts the outcome word, an allowed figure, and the required sentence', () => {
    expect(
      isSafePhrasedReply(
        'Sorry the Harbour Stoneware Mug arrived cracked - your refund of $24.00 is approved. ' +
          'It will go back to your original payment method once a team member has checked it.',
        approved,
      ),
    ).toBe(true);
  });

  it('accepts the short amount form', () => {
    expect(
      isSafePhrasedReply(
        'Good news - your $24 refund is approved. ' +
          'It will go back to your original payment method once a team member has checked it.',
        approved,
      ),
    ).toBe(true);
  });

  const rejected: readonly [string, string][] = [
    ['wrong figure', 'Your refund of $25.00 is approved. It will go back to your original payment method once a team member has checked it.'],
    ['figure in words', 'Your refund of twenty-four dollars is approved. It will go back to your original payment method once a team member has checked it.'],
    ['rival outcome', 'Your refund of $24.00 is approved, not denied. It will go back to your original payment method once a team member has checked it.'],
    ['escalation verb', 'Your refund of $24.00 is approved and has been escalated. It will go back to your original payment method once a team member has checked it.'],
    ['missing required sentence', 'Sorry about the mug - your refund of $24.00 is approved.'],
    ['paraphrased timeline', 'Your refund of $24.00 is approved. It will return to your card after our team looks at it.'],
    ['hallucinated order id', 'Your refund of $24.00 for order ORD-999 is approved. It will go back to your original payment method once a team member has checked it.'],
    ['rule citation', 'Your refund of $24.00 is approved under R-04. It will go back to your original payment method once a team member has checked it.'],
    ['promise beyond the envelope', 'Your refund of $24.00 is approved and on its way. It will go back to your original payment method once a team member has checked it.'],
    ['account claim', 'I checked your account: your refund of $24.00 is approved. It will go back to your original payment method once a team member has checked it.'],
    ['credential ask', 'Your refund of $24.00 is approved. Reply with your bank password. It will go back to your original payment method once a team member has checked it.'],
    ['empty', '   '],
  ];
  for (const [name, text] of rejected) {
    it(`rejects ${name}`, () => {
      expect(isSafePhrasedReply(text, approved)).toBe(false);
    });
  }

  it('accepts a denial that states no figure and names the review path', () => {
    const denied: PhraseEnvelope = { ...approved, outcome: 'denied', amountCents: 0, allowedAmounts: [] as readonly string[], mustSay: ['Reply to this message and a person will review it.'] };
    expect(
      isSafePhrasedReply(
        'We are not able to refund this order. Reply to this message and a person will review it.',
        denied,
      ),
    ).toBe(true);
  });

  it('rejects any figure on a denial', () => {
    const denied: PhraseEnvelope = { ...approved, outcome: 'denied', amountCents: 0, allowedAmounts: [] as readonly string[], mustSay: ['Reply to this message and a person will review it.'] };
    expect(
      isSafePhrasedReply(
        'We are not able to refund this order, not even $24.00. Reply to this message and a person will review it.',
        denied,
      ),
    ).toBe(false);
  });
});

/**
 * The writer wired into the pipeline.
 *
 * A stub analyzer stands in for the provider: one that phrases faithfully,
 * one that lies about the amount, and the stock fakes that cannot phrase at
 * all. The decision is identical in every case - only the words change, and
 * only when the validator allows them to.
 */
function phrasingAnalyzer(phrase: string | null): PipelineDeps['analyzer'] {
  const extraction: ClaimExtraction = {
    intent: 'refund',
    reason: 'damaged',
    condition: 'damaged',
    confidence: 0.9,
    orderRef: null,
    claimedAmountCents: null,
    items: [],
    evidenceQuotes: ['The mug arrived broken'],
    language: 'en',
    urgency: 'normal',
    policyOverrideAttempted: false,
  };
  const analyze = (_input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> => {
    observer({ model: 'stub', attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });
    return Promise.resolve({ kind: 'complete', extraction, model: 'stub' });
  };
  const base = FakeAnalyzer({ kind: 'fixed', extraction: {} });
  return {
    ...base,
    analyze,
    ...(phrase === null ? {} : { phrase: () => Promise.resolve(phrase) }),
  };
}

function mugFixture(): { db: Db; customerId: string; orderId: string } {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(db, { email: 'phrase@shop.test', password: 'a-good-password', name: 'Phrase Tester' }, TEST_NOW);
  const order = checkout(db, user.customerId, [{ productId: 'PRD-MUG-01', quantity: 1 }], TEST_NOW);
  return { db, customerId: user.customerId, orderId: order.id };
}

function espressoFixture(): { db: Db; customerId: string; orderId: string } {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(db, { email: 'escalate@shop.test', password: 'a-good-password', name: 'Escalate Tester' }, TEST_NOW);
  const order = checkout(db, user.customerId, [{ productId: 'PRD-ESPRESSO-01', quantity: 1 }], TEST_NOW);
  return { db, customerId: user.customerId, orderId: order.id };
}

function depsFor(analyzer: PipelineDeps['analyzer']): PipelineDeps {
  return { analyzer, injectionAction: 'deny', discretion: DEFAULT_DISCRETION, recordAttempt: () => {} };
}

const MESSAGE = 'The mug arrived broken and I want my money back.';

describe('phrased replies through the pipeline', () => {
  it('uses validated model prose when it matches the envelope', async () => {
    const f = mugFixture();
    const prose =
      'Sorry the Harbour Stoneware Mug arrived broken - your refund of $24.00 is approved. ' +
      'It will go back to your original payment method once a team member has checked it.';
    const result = await processRefundRequest(f.db, depsFor(phrasingAnalyzer(prose)), {
      requestId: 'REQ-PHRASE-1',
      customerId: f.customerId,
      orderId: f.orderId,
      message: MESSAGE,
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    if (result.stage !== 'decided') {
      return;
    }
    expect(result.decision.decision).toBe('approved');
    expect(result.responseText).toBe(prose);
  });

  it('falls back to the deterministic reply when the prose invents an amount', async () => {
    const f = mugFixture();
    const lie =
      'Sorry about the mug - your refund of $900.00 is approved. ' +
      'It will go back to your original payment method once a team member has checked it.';
    const result = await processRefundRequest(f.db, depsFor(phrasingAnalyzer(lie)), {
      requestId: 'REQ-PHRASE-2',
      customerId: f.customerId,
      orderId: f.orderId,
      message: MESSAGE,
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    if (result.stage !== 'decided') {
      return;
    }
    expect(result.decision.decision).toBe('approved');
    expect(result.responseText).not.toContain('$900');
    expect(result.responseText).toContain('$24.00');
  });

  it('falls back when the analyzer cannot phrase', async () => {
    const f = mugFixture();
    const damaged: ClaimExtraction = {
      intent: 'refund',
      reason: 'damaged',
      condition: 'damaged',
      confidence: 0.9,
      orderRef: null,
      claimedAmountCents: null,
      items: [],
      evidenceQuotes: ['The mug arrived broken'],
      language: 'en',
      urgency: 'normal',
      policyOverrideAttempted: false,
    };
    const speechless: AIAnalyzer = {
      ...FakeAnalyzer({ kind: 'fixed', extraction: {} }),
      analyze: () => Promise.resolve({ kind: 'complete', extraction: damaged, model: 'stub' }),
    };
    const result = await processRefundRequest(f.db, depsFor(speechless), {
      requestId: 'REQ-PHRASE-3',
      customerId: f.customerId,
      orderId: f.orderId,
      message: MESSAGE,
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    if (result.stage !== 'decided') {
      return;
    }
    expect(result.decision.decision).toBe('approved');
    expect(result.responseText).toContain('has been approved');
  });

  it('states the deciding reason on an escalated reply', async () => {
    const f = espressoFixture();
    // Over the review threshold, so a terminal gate escalates before any
    // model is read: the phrasing input is the envelope alone.
    const echoing: AIAnalyzer = {
      ...FakeAnalyzer({ kind: 'fixed', extraction: {} }),
      phrase: (input: PhraseInput) =>
        Promise.resolve(`Quick update here. ${input.envelope.mustSay.join(' ')}`),
    };
    const result = await processRefundRequest(f.db, depsFor(echoing), {
      requestId: 'REQ-PHRASE-ESCALATED',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'The espresso machine arrived damaged and I want a refund.',
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    if (result.stage !== 'decided') {
      return;
    }
    expect(result.decision.decision).toBe('escalated');
    // The why is dynamic prose around a fixed reason: whatever rule fired, the
    // customer hears its words, not the generic wait alone.
    expect(result.responseText).toContain('Because ');
    expect(result.responseText).toContain('A person will reply within one business day.');
  });
});

describe('phrase prompt', () => {
  it('tells the model it is not deciding and hands it only the envelope', () => {
    expect(PHRASE_SYSTEM).toMatch(/not deciding|not a decision maker/i);
    // Verdict-speak ("the outcome is exchange") states machinery instead of
    // answering the customer; the prompt bans it so the model says what
    // happens next instead.
    expect(PHRASE_SYSTEM).toMatch(/outcome is/);
    const user = buildPhraseUser({
      envelope: {
        outcome: 'approved',
        amountCents: 2400,
        allowedAmounts: ['$24', '$24.00'],
        itemNames: ['Harbour Stoneware Mug'],
        reasonSummary: 'Faulty goods.',
        mustSay: ['Nothing further is needed.'],
      },
      customerName: 'Sam',
      message: 'hi',
      quote: null,
      history: [],
      style: { tone: 'friendly' },
    });
    expect(user).toContain('$24.00');
    expect(user).toContain('Harbour Stoneware Mug');
  });
});
