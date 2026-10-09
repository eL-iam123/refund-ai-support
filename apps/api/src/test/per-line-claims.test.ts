import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/connection.js';
import type { OrderItemRecord, OrderRecord } from '../db/records.js';
import type { ClaimExtraction } from '@refund/shared';
import { runFactGates } from '../policy/gates.js';
import { evaluateRules } from '../policy/engine.js';
import { rulesForStage } from '../policy/rules/index.js';
import { resolve } from '../policy/resolver.js';
import { verifyGrounding } from '../ai/grounding.js';
import { composeDeterministicResponse } from '../response/compose.js';
import type { PolicyContext } from '../policy/types.js';

/**
 * The per-line fold (§5.1/§5.3): a mixed basket is paid line by line.
 *
 * The whole-message model has one verdict for a message. That verdict is wrong
 * for half of a two-line complaint: "the mug arrived cracked and the lamp stand
 * wobbles now" mentions a grounded problem for the mug and nothing verifiable
 * about the lamp - yet the whole-message grounding is true, and under the old
 * reading R-04 would approve both lines, or R-12 would escalate both. The
 * per-line reading splits the difference because the *line* is the unit a
 * reason actually applies to.
 */

const ORDER_ID = 'ORD-PERLINE';

function item(id: string, name: string, unitPriceCents: number): OrderItemRecord {
  return {
    id,
    name,
    unitPriceCents,
    quantity: 1,
    finalSale: false,
    digital: false,
    downloaded: false,
    isSubscription: false,
  };
}

const MUG_ID = 'ITM-ORD-PERLINE-01';
const LAMP_ID = 'ITM-ORD-PERLINE-02';
const RUG_ID = 'ITM-ORD-PERLINE-03';

const MUG = item(MUG_ID, 'Ceramic Mug', 1500);
const LAMP = item(LAMP_ID, 'Arc Floor Lamp', 4500);
const RUG = item(RUG_ID, 'Wool Rug', 9999);

const MESSAGE = 'the mug arrived cracked and the lamp stand wobbles now';

/** The claim whole-message grounding says is true, per-line grounding does not. */
function mixedExtraction(): ClaimExtraction {
  return {
    intent: 'refund',
    reason: 'damaged',
    condition: 'damaged',
    confidence: 0.9,
    orderRef: null,
    claimedAmountCents: null,
    items: [MUG_ID, LAMP_ID],
    evidenceQuotes: ['the mug arrived cracked'],
    language: 'en',
    urgency: 'normal',
    policyOverrideAttempted: false,
    lineClaims: [
      {
        itemId: MUG_ID,
        reason: 'damaged',
        condition: 'damaged',
        confidence: 0.9,
        evidenceQuotes: ['the mug arrived cracked'],
      },
      {
        itemId: LAMP_ID,
        reason: 'damaged',
        condition: 'damaged',
        confidence: 0.8,
        // Reported as "lamp" + "broken" - neither is anywhere in the message.
        evidenceQuotes: ['lamp broken on arrival'],
      },
    ],
  };
}

function orderWith(items: readonly OrderItemRecord[], totalCents: number): OrderRecord {
  return {
    id: ORDER_ID,
    customerId: 'CUST-PERLINE',
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

function decide(input: {
  items: readonly OrderItemRecord[];
  totalCents: number;
  extraction: ClaimExtraction | null;
  message: string;
  claimedItemIds?: readonly string[];
  reasonOverride?: never;
}): {
  decision: ReturnType<typeof resolve>;
  order: OrderRecord;
  reasonEvaluations: ReturnType<typeof evaluateRules>;
  gates: ReturnType<typeof runFactGates>;
  grounding: ReturnType<typeof verifyGrounding>;
} {
  const db = openMemoryDatabase();
  const order = orderWith(input.items, input.totalCents);
  const claimed = input.claimedItemIds ?? input.items.map((it) => it.id);
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
  const gates = runFactGates(context, claimed);
  const grounding = verifyGrounding(input.extraction, [input.message]);
  const reasonEvaluations = evaluateRules(rulesForStage("reason_rules"), {
    ...context,
    claimedItemIds: claimed,
    eligibleItems: gates.eligibleItems,
    blockedItems: gates.blockedItems,
    eligibleAmountCents: gates.eligibleAmountCents,
    extraction: input.extraction,
    grounding,
  });
  const decision = resolve({
    intakeEvaluations: [],
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
    claimedItemIds: claimed,
  });
  return { decision, order, reasonEvaluations, gates, grounding };
}

describe('a mixed basket is paid line by line', () => {
  it('grounds each line apart, so the lamp fails while the mug and the message pass', () => {
    const { grounding } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: mixedExtraction(),
      message: MESSAGE,
    });
    expect(grounding?.grounded).toBe(true); // the whole message is verifiable...
    expect(grounding?.lines).toHaveLength(2);
    expect(grounding?.lines?.[0]).toMatchObject({ itemId: MUG_ID, grounded: true });
    expect(grounding?.lines?.[1]).toMatchObject({ itemId: LAMP_ID, grounded: false });
  });

  it('pays the grounded line and sends the ungrounded line to a person', () => {
    const { decision, reasonEvaluations } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: mixedExtraction(),
      message: MESSAGE,
    });

    const approve = reasonEvaluations.find((rule) => rule.ruleId === 'R-04');
    const escalate = reasonEvaluations.find((rule) => rule.ruleId === 'R-12');
    expect(approve).toMatchObject({ outcome: 'approve', scope: 'item', itemIds: [MUG_ID] });
    expect(escalate).toMatchObject({ outcome: 'escalate', scope: 'item', itemIds: [LAMP_ID] });

    expect(decision.decision).toBe('partial_refund');
    // The mug only. The lamp is not "approved at zero" - it is under review.
    expect(decision.refundAmountCents).toBe(1500);
    expect(decision.eligibleAmountCents).toBe(6000);
    // R-12's lines appear as blocked items so the reply can name them...
    expect(decision.blockedItems).toHaveLength(1);
    expect(decision.blockedItems[0]).toMatchObject({ itemId: LAMP_ID, ruleId: 'R-12' });
    // ...while the summary calls them what they are.
    expect(decision.summary).toContain('Partially refunded');
    expect(decision.summary).toContain('1 line is under review');
    expect(decision.policyRef).toBe('REFUND_POLICY.md §5.1');
  });

  it('tells the customer the lamp is being checked, not that it is refused', () => {
    const { decision, order } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: mixedExtraction(),
      message: MESSAGE,
    });
    const text = composeDeterministicResponse(decision, order, MESSAGE);
    expect(text).toContain('$15.00');
    expect(text).toContain('being checked by a member of our team before anything for it is refunded');
    expect(text).not.toContain('not eligible for a refund');
  });
});

describe('when every claimed line fails verification', () => {
  it('escalates the lines a person should read, and pays nothing', () => {
    const ungrounded: ClaimExtraction = {
      ...mixedExtraction(),
      evidenceQuotes: ['the lamp stand wobbles now'],
      lineClaims: [
        {
          itemId: MUG_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.7,
          evidenceQuotes: ['mug shattered'],
        },
        {
          itemId: LAMP_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.7,
          evidenceQuotes: ['lamp broken'],
        },
      ],
    };
    const { decision } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: ungrounded,
      message: MESSAGE,
    });

    expect(decision.decision).toBe('escalated');
    expect(decision.refundAmountCents).toBe(0);
    expect(decision.blockedItems.map((item) => item.itemId).sort()).toEqual([LAMP_ID, MUG_ID].sort());
    expect(decision.blockedItems.every((item) => item.ruleId === 'R-12')).toBe(true);
  });
});

describe('a line the customer never claimed is not sent for review', () => {
  it('pays the claimed mug and leaves the model-invented lamp out of both lists', () => {
    const { decision } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: mixedExtraction(),
      message: MESSAGE,
      // The customer only touched the mug. The lamp claim was the model's.
      claimedItemIds: [MUG_ID],
    });

    expect(decision.decision).toBe('approved');
    expect(decision.refundAmountCents).toBe(1500);
    expect(decision.blockedItems).toHaveLength(0);
  });
});

describe('legacy fallback: no lineClaims, one reading for the message', () => {
  it('approves the whole eligible amount on a whole-message grounded claim', () => {
    const legacy: ClaimExtraction = {
      ...mixedExtraction(),
      lineClaims: [],
      items: [MUG_ID, LAMP_ID],
      evidenceQuotes: ['the mug arrived cracked'],
    };
    const { decision, reasonEvaluations } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: legacy,
      message: MESSAGE,
    });

    // Same as before the per-line model existed: one order-scoped approval,
    // no lines split, no review noise.
    expect(reasonEvaluations.find((rule) => rule.ruleId === 'R-04')).toMatchObject({
      outcome: 'approve',
      scope: 'order',
    });
    expect(reasonEvaluations.find((rule) => rule.ruleId === 'R-12')?.outcome).toBe('pass');
    expect(decision.decision).toBe('approved');
    expect(decision.refundAmountCents).toBe(6000);
    expect(decision.blockedItems).toHaveLength(0);
  });

  it('still escalates an ungrounded whole-message claim', () => {
    const legacy: ClaimExtraction = {
      ...mixedExtraction(),
      evidenceQuotes: ['mug broken'],
      lineClaims: [],
    };
    const { decision } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: legacy,
      message: MESSAGE,
    });
    expect(decision.decision).toBe('escalated');
    expect(decision.refundAmountCents).toBe(0);
    expect(decision.trace.find((rule) => rule.ruleId === 'R-12')).toMatchObject({
      outcome: 'escalate',
      scope: 'order',
    });
  });
});

describe('the split cannot outrank a whole-request verdict', () => {
  it('a person decides first when the request conflicts with earlier records', () => {
    const extraction = mixedExtraction();
    const { order, gates, reasonEvaluations, grounding } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction,
      message: MESSAGE,
    });
    const verdict = resolve({
      intakeEvaluations: [],
      gateResult: gates,
      reasonEvaluations: [
        ...reasonEvaluations,
        {
          ruleId: 'R-09' as const,
          ruleClass: 'approval-authority' as const,
          scope: 'order' as const,
          outcome: 'escalate' as const,
          evidence: 'the transcript conflicts with an earlier claim on the same order',
          policyRef: 'REFUND_POLICY.md §5.4',
          itemIds: [],
        },
      ],
      grounding,
      aiProposal: null,
      orderTotalCents: order.totalCents,
      orderId: order.id,
      disputeCeilingCents: null,
      db: openMemoryDatabase(),
      order,
      extraction,
      claimedItemIds: [MUG_ID, LAMP_ID],
    });
    // The per-line split got as far as paying the mug - its evaluation is on the
    // trace - and the conflicting-records verdict still outranks it.
    expect(reasonEvaluations.find((rule) => rule.ruleId === 'R-04')?.outcome).toBe('approve');
    expect(verdict.decision).toBe('escalated');
    expect(verdict.refundAmountCents).toBe(0);
  });

  it('judges the confidence floor per line: a confident grounded line pays despite a shaky message', () => {
    // The "shaky message" number is the model talking about the message as a
    // whole. The mug's own line was read at 0.9; the floor applies to the line
    // being paid, so the mug is paid and only the lamp (read at 0.8) is
    // reviewed. A whole-message floor that vetoed a confidently-read line
    // would reintroduce, through the back door, the single verdict the per-line
    // read exists to replace.
    const lowWholeMessage: ClaimExtraction = {
      ...mixedExtraction(),
      confidence: 0.3,
    };
    const { decision } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: lowWholeMessage,
      message: MESSAGE,
    });
    expect(decision.decision).toBe('partial_refund');
    expect(decision.refundAmountCents).toBe(1500);
  });

  it('stops the money when the grounded line itself was read below the floor', () => {
    const shakyMug: ClaimExtraction = {
      ...mixedExtraction(),
      confidence: 0.3,
      lineClaims: [
        {
          itemId: MUG_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.3,
          evidenceQuotes: ['the mug arrived cracked'],
        },
        {
          itemId: LAMP_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.9,
          evidenceQuotes: ['lamp broken on arrival'],
        },
      ],
    };
    const { decision } = decide({
      items: [MUG, LAMP],
      totalCents: 6000,
      extraction: shakyMug,
      message: MESSAGE,
    });
    expect(decision.decision).toBe('escalated');
    expect(decision.refundAmountCents).toBe(0);
    expect(decision.overrides.map((override) => override.code)).toContain(
      'low_confidence_claim_escalated',
    );
  });
});

describe('a fact-blocked line stays a refusal, not a review', () => {
  it('ineligibles and review lines get distinct reasons in the same reply', () => {
    const rug = { ...RUG, finalSale: true };
    const extraction: ClaimExtraction = {
      ...mixedExtraction(),
      items: [MUG_ID, RUG_ID, LAMP_ID],
      lineClaims: [
        {
          itemId: MUG_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.9,
          evidenceQuotes: ['the mug arrived cracked'],
        },
        {
          itemId: RUG_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.9,
          evidenceQuotes: ['the rug is stained'],
        },
        {
          itemId: LAMP_ID,
          reason: 'damaged',
          condition: 'damaged',
          confidence: 0.8,
          evidenceQuotes: ['lamp broken on arrival'],
        },
      ],
    };
    const { decision, order } = decide({
      items: [MUG, rug, LAMP],
      totalCents: 15999,
      extraction,
      message: 'the mug arrived cracked, the rug is stained and the lamp stand wobbles now',
    });

    // R-02 refused the final-sale rug at the fact gates; it was never claimed
    // per line. The lamp is the review line; the mug is paid.
    expect(decision.refundAmountCents).toBe(1500);
    const rugBlocked = decision.blockedItems.find((item) => item.itemId === RUG_ID);
    const lampBlocked = decision.blockedItems.find((item) => item.itemId === LAMP_ID);
    expect(rugBlocked?.ruleId).toBe('R-02');
    expect(lampBlocked?.ruleId).toBe('R-12');

    const text = composeDeterministicResponse(decision, order, 'the rug is stained');
    expect(text).toContain('Wool Rug is not eligible for a refund');
    expect(text).toContain('Arc Floor Lamp is being checked by a member of our team');
  });
});