import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/connection.js';
import type { Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import type { OrderItemRecord, OrderRecord } from '../db/records.js';
import type { ClaimExtraction, RuleEvaluation } from '@refund/shared';
import { runFactGates } from '../policy/gates.js';
import { evaluateRules } from '../policy/engine.js';
import { rulesForStage } from '../policy/rules/index.js';
import { resolve } from '../policy/resolver.js';
import { verifyGrounding } from '../ai/grounding.js';
import { asksForSwap } from '../response/intent.js';
import { composeDeterministicResponse } from '../response/compose.js';
import type { PolicyContext } from '../policy/types.js';
import { processRefundRequest, DEFAULT_DISCRETION } from '../orchestrator.js';
import type { PipelineDeps } from '../orchestrator.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { TEST_NOW } from './helpers.js';

/**
 * A swap ask is a remedy, not an unreadable message.
 *
 * The reported transcript: "can i swap it instead?" - read perfectly by the
 * model (intent exchange, confidence 0.9, quoted evidence) - escalated under
 * R-12 as "no refund reason". The resolver never looked at intent, so the one
 * remedy the customer actually named was the one outcome the engine could not
 * reach. These tests hold the whole path: the words, the rule, the resolver,
 * and the reply the customer reads.
 */

const KETTLE_ID = 'ITM-SWAP-01';
const KETTLE: OrderItemRecord = {
  id: KETTLE_ID,
  name: 'Copper Pour-Over Kettle',
  unitPriceCents: 8900,
  quantity: 1,
  finalSale: false,
  digital: false,
  downloaded: false,
  isSubscription: false,
};

function orderWith(items: readonly OrderItemRecord[], totalCents: number): OrderRecord {
  return {
    id: 'ORD-SWAP',
    customerId: 'CUST-SWAP',
    placedAt: new Date('2026-05-01T00:00:00.000Z'),
    deliveredAt: new Date('2026-05-05T00:00:00.000Z'),
    ageDays: 4,
    status: 'delivered',
    paymentState: 'settled',
    refundedCents: 0,
    totalCents,
    isSubscription: false,
    trackingStatus: 'delivered',
    signedByCustomer: true,
    conditionAtDelivery: null,
    items: [...items],
  };
}

/** The transcript's reading: a swap ask on the kettle, stated twice. */
function swapExtraction(): ClaimExtraction {
  return {
    intent: 'exchange',
    reason: 'other',
    condition: 'unknown',
    confidence: 0.9,
    orderRef: null,
    claimedAmountCents: null,
    items: [KETTLE_ID],
    evidenceQuotes: ['not the size i was expecting', 'can i swap it instead?'],
    language: 'en',
    urgency: 'normal',
    policyOverrideAttempted: false,
    lineClaims: [],
  };
}

const SWAP_MESSAGE = 'can i swap it instead?';

function decide(input: {
  message: string;
  extraction: ClaimExtraction;
  intake?: readonly RuleEvaluation[];
  customerRequestedAgent?: boolean;
}) {
  const db = openMemoryDatabase();
  const order = orderWith([KETTLE], 8900);
  const context: PolicyContext = {
    db,
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
  const gates = runFactGates(context, [KETTLE_ID]);
  const grounding = verifyGrounding(input.extraction, [input.message]);
  const reasonEvaluations = evaluateRules(rulesForStage('reason_rules'), {
    ...context,
    eligibleItems: gates.eligibleItems,
    blockedItems: gates.blockedItems,
    eligibleAmountCents: gates.eligibleAmountCents,
    extraction: input.extraction,
    grounding,
  });
  const decision = resolve({
    intakeEvaluations: input.intake ?? [],
    gateResult: gates,
    reasonEvaluations,
    grounding,
    aiProposal: null,
    orderTotalCents: order.totalCents,
    orderId: order.id,
    disputeCeilingCents: null,
    db,
    order,
    extraction: input.extraction,
    customerMessage: input.message,
    customerRequestedAgent: input.customerRequestedAgent,
    claimedItemIds: [KETTLE_ID],
  });
  return { decision, reasonEvaluations, grounding };
}

function objection(ruleId: 'R-07' | 'R-02', outcome: 'escalate' | 'deny'): RuleEvaluation {
  return {
    ruleId,
    ruleClass: ruleId === 'R-07' ? 'risk' : 'eligibility',
    scope: 'order',
    outcome,
    evidence: 'test objection',
    policyRef: 'REFUND_POLICY.md §6',
    itemIds: [],
  };
}

describe('hearing a swap ask', () => {
  it('matches swap wording and not refund wording', () => {
    expect(asksForSwap('can i swap it instead?')).toBe(true);
    expect(asksForSwap('I want to exchange the kettle')).toBe(true);
    expect(asksForSwap('send a replacement please')).toBe(true);
    expect(asksForSwap('not the size i was expecting, a different size please')).toBe(true);
    expect(asksForSwap('I want a refund')).toBe(false);
    expect(asksForSwap('the kettle arrived broken')).toBe(false);
    expect(asksForSwap('what is your policy')).toBe(false);
  });
});

describe('R-12 on a swap ask', () => {
  it('passes: a named remedy is not an unreadable request', () => {
    const { reasonEvaluations } = decide({ message: SWAP_MESSAGE, extraction: swapExtraction() });
    const r12 = reasonEvaluations.find((rule) => rule.ruleId === 'R-12');
    expect(r12?.outcome).toBe('pass');
  });
});

describe('resolving a swap ask', () => {
  it('decides an exchange, moves no money, and says swap', () => {
    const { decision } = decide({ message: SWAP_MESSAGE, extraction: swapExtraction() });
    expect(decision.decision).toBe('exchange');
    expect(decision.refundAmountCents).toBe(0);
    expect(decision.eligibleItemIds).toContain(KETTLE_ID);
    expect(decision.summary).toMatch(/swap/i);
    const reply = composeDeterministicResponse(decision, orderWith([KETTLE], 8900), SWAP_MESSAGE);
    expect(reply).toMatch(/swap it instead/);
    expect(reply).toMatch(/confirm the details/);
  });

  it('leaves a denial standing', () => {
    const { decision } = decide({
      message: SWAP_MESSAGE,
      extraction: swapExtraction(),
      intake: [objection('R-02', 'deny')],
    });
    expect(decision.decision).toBe('denied');
  });

  it('leaves a risk hold standing', () => {
    const { decision } = decide({
      message: SWAP_MESSAGE,
      extraction: swapExtraction(),
      intake: [objection('R-07', 'escalate')],
    });
    expect(decision.decision).toBe('escalated');
  });

  it('ignores a denial on a line nobody claimed', () => {
    // The basket holds a final-sale line the customer never mentioned. Its
    // denial is true of the order and false of the case: the swap is about
    // the kettle, so the kettle's exchange stands.
    const { decision } = decide({
      message: SWAP_MESSAGE,
      extraction: swapExtraction(),
      intake: [
        {
          ruleId: 'R-02',
          ruleClass: 'eligibility',
          scope: 'item',
          outcome: 'deny',
          evidence: 'final sale line elsewhere in the basket',
          policyRef: 'REFUND_POLICY.md §2.1',
          itemIds: ['ITM-ELSEWHERE'],
        },
      ],
    });
    expect(decision.decision).toBe('exchange');
  });

  it('stands down when the denial is on the claimed line', () => {
    const { decision } = decide({
      message: SWAP_MESSAGE,
      extraction: swapExtraction(),
      intake: [
        {
          ruleId: 'R-02',
          ruleClass: 'eligibility',
          scope: 'item',
          outcome: 'deny',
          evidence: 'the claimed kettle is final sale',
          policyRef: 'REFUND_POLICY.md §2.1',
          itemIds: [KETTLE_ID],
        },
      ],
    });
    expect(decision.decision).toBe('escalated');
  });

  it('escalates a swap nobody stands behind', () => {
    const vague: ClaimExtraction = { ...swapExtraction(), confidence: 0.2 };
    const { decision } = decide({ message: SWAP_MESSAGE, extraction: vague });
    expect(decision.decision).toBe('escalated');
  });

  it('escalates an inferred swap the customer never asked for', () => {
    // The model read exchange intent, but the message never says swap: an
    // inferred remedy is not an asked one, so the rules keep the request.
    const { decision } = decide({ message: 'the size is wrong', extraction: swapExtraction() });
    expect(decision.decision).toBe('escalated');
  });

  it('hands the exchange to a person the customer asked for', () => {
    const { decision } = decide({
      message: `${SWAP_MESSAGE} and I want to speak to a real person`,
      extraction: swapExtraction(),
      customerRequestedAgent: true,
    });
    expect(decision.decision).toBe('escalated');
    expect(decision.overrides.map((o) => o.code)).toContain('agent_requested_by_customer');
  });

  it('honours a replacement ask on a faulty item instead of refunding it', () => {
    // The remedy choice is the customer's: damage plus "send a replacement"
    // is an exchange, not an approval that pays money unasked.
    const damaged: ClaimExtraction = {
      ...swapExtraction(),
      reason: 'damaged',
      condition: 'damaged',
      evidenceQuotes: ['the handle is cracked', 'send a replacement'],
    };
    const { decision } = decide({ message: 'the handle is cracked, send a replacement', extraction: damaged });
    expect(decision.decision).toBe('exchange');
    expect(decision.refundAmountCents).toBe(0);
  });
});

describe('a swap ask end to end', () => {
  function makeDeps(): PipelineDeps {
    return {
      analyzer: FakeAnalyzer({
        kind: 'fixed',
        extraction: {
          intent: 'exchange',
          reason: 'other',
          condition: 'unknown',
          confidence: 0.9,
          orderRef: null,
          claimedAmountCents: null,
          items: [],
          evidenceQuotes: ['can i swap it instead?'],
          language: 'en',
          urgency: 'normal',
          policyOverrideAttempted: false,
        },
      }),
      injectionAction: 'deny',
      discretion: DEFAULT_DISCRETION,
      recordAttempt: () => {},
    };
  }

  function makeFixture(): { db: Db; customerId: string; orderId: string } {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(
      db,
      { email: 'swap@shop.test', password: 'a-good-password', name: 'Swap Tester' },
      TEST_NOW,
    );
    const order = checkout(
      db,
      user.customerId,
      [
        { productId: 'PRD-LAMP-01', quantity: 1 },
        { productId: 'PRD-MUG-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    return { db, customerId: user.customerId, orderId: order.id };
  }

  it('decides an exchange instead of an R-12 escalation', async () => {
    const f = makeFixture();
    const mug = f.db
      .prepare('SELECT id FROM order_items WHERE order_id = ? AND name LIKE ?')
      .get(f.orderId, '%Mug%') as { id: string } | undefined;
    const result = await processRefundRequest(f.db, makeDeps(), {
      requestId: 'REQ-SWAP-1',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'can i swap it instead?',
      itemIds: mug === undefined ? [] : [mug.id],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    if (result.stage !== 'decided') {
      return;
    }
    expect(result.decision.decision).toBe('exchange');
    expect(result.decision.refundAmountCents).toBe(0);
    // Answered, not announced: the customer asked "can i swap it?", so the
    // reply leads with yes rather than a verdict about an outcome.
    expect(result.responseText).toMatch(/^Yes/);
  });
});