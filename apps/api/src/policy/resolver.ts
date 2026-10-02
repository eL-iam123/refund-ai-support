import {
  type AiProposal,
  type ClaimExtraction,
  type Decision,
  type GroundingResult,
  type OverrideCode,
  type OverrideRecord,
  type RefundDecision,
  type RuleEvaluation,
} from '@refund/shared';
import { assertAmountSane } from '../lib/assert.js';
import { formatCents } from '../lib/money.js';
import { settledCentsForOrder, pendingCentsForOrder } from '../db/refundLedger.js';
import type { Db } from '../db/connection.js';
import type { CustomerRecord, OrderRecord } from '../db/records.js';
import type { DiscretionConfig } from '../config/env.js';
import { precedenceFold } from './engine.js';
import type { GateResult } from './gates.js';
import { describeCeiling } from '../retrieval/identifyOrder.js';
import {
  recommendDiscretion,
  DEFAULT_DISCRETION,
  decisionFromRecommendation,
  type DecisionKind,
  type DiscretionRecommendation,
} from './discretion.js';

export interface ResolveInput {
  /** R-14 and anything else established during intake. */
  readonly intakeEvaluations: readonly RuleEvaluation[];
  readonly gateResult: GateResult;
  readonly reasonEvaluations: readonly RuleEvaluation[];
  readonly grounding: GroundingResult | null;
  readonly aiProposal: AiProposal | null;
  readonly orderTotalCents: number;
  readonly orderId: string | null;
  /**
   * The most that may be paid, when the request points at specific products.
   * Null means the customer claimed the whole order and the eligible amount
   * applies. Never above the eligible amount: a cap that raised the payout
   * would be a bug wearing a safety label.
   */
  readonly disputeCeilingCents: number | null;
  /** The ledger, for money already committed to the order by earlier claims. */
  readonly db: Db;
  /** Null when no order resolved; the outstanding figures are then zero. */
  readonly order: OrderRecord | null;
  /** The model's reading of the message, when it produced one. Inert data. */
  readonly extraction?: ClaimExtraction | null;
  /** The customer, for the discretion layer's loyalty rule. */
  readonly customer?: CustomerRecord | null;
  /** The operator's pre-authorised discretion bounds. Defaults to off. */
  readonly discretion?: DiscretionConfig;
}

const VERB: Record<Decision, string> = {
  approved: 'Approved',
  denied: 'Denied',
  escalated: 'Escalated for human review',
  partial_refund: 'Partially refunded',
  exchange: 'Resolved with an exchange',
  store_credit: 'Resolved with store credit',
};

/**
 * The resolver is the only writer of a decision in this system.
 *
 * An AI proposal arrives here as *data*. It can be recorded, compared against
 * what the policy concluded, and reported in the audit trail - but it cannot
 * change the outcome. Precedence is DENY > ESCALATE > APPROVE, and when no rule
 * reaches a conclusion the safe default is to escalate, never to approve.
 */
export function resolve(input: ResolveInput): RefundDecision {
  const evaluations = [
    ...input.intakeEvaluations,
    ...input.gateResult.evaluations,
    ...input.reasonEvaluations,
  ];
  const winner = decidingRule(input, evaluations);
  const baseDecision = decisionFrom(winner);
  const softened = applyDiscretion(baseDecision, winner, evaluations, input);
  const decision = softened.decision;
  const amount = amountFor(decision, input, softened.partialAmountCents);
  const ceiling = ceilingOverride(input, amount);
  const overrides = [...softened.overrides, ...reconcile(input, decision, amount), ...ceiling];
  assertAmountSane(amount, input.orderTotalCents);

  return {
    decision,
    refundAmountCents: amount,
    eligibleAmountCents: input.gateResult.eligibleAmountCents,
    currency: 'USD',
    summary: summarise(decision, winner, input, amount, softened.applied),
    policyRef: winner?.policyRef ?? 'REFUND_POLICY.md §9',
    trace: evaluations,
    overrides,
    eligibleItemIds: input.gateResult.eligibleItems.map((item) => item.id),
    blockedItems: input.gateResult.blockedItems,
    ...outstandingFor(input),
  };
}

function stateOf(settled: number, pending: number): 'pending' | 'settled' | 'mixed' {
  if (settled > 0 && pending > 0) {
    return 'mixed';
  }
  return pending > 0 ? 'pending' : 'settled';
}

/**
 * What earlier claims have already committed to this order, if it resolved.
 *
 * Read from the ledger rather than the order row, because a pending approval
 * exists only in the ledger: the order still shows zero refunded until a person
 * settles it. That gap is exactly the case the reply needs to explain.
 */
function outstandingFor(input: ResolveInput): Pick<
  RefundDecision,
  'outstandingAmountCents' | 'outstandingState'
> {
  if (input.order === null || input.order === undefined) {
    return { outstandingAmountCents: 0, outstandingState: 'none' };
  }
  const settled = Math.max(
    input.order.refundedCents,
    settledCentsForOrder(input.db, input.order.id),
  );
  const pending = pendingCentsForOrder(input.db, input.order.id);
  const total = settled + pending;
  if (total === 0) {
    return { outstandingAmountCents: 0, outstandingState: 'none' };
  }
  return { outstandingAmountCents: total, outstandingState: stateOf(settled, pending) };
}

/**
 * Picks the rule that decides the request.
 *
 * Two subtleties, and S-17 is the scenario that exists to hold both of them.
 *
 * Item-scoped outcomes are excluded from the fold. A final-sale item that has
 * been excluded from the basket is an *adjustment*, not a refusal: if it could
 * outrank an order-scoped approval, removing one item from a mixed order would
 * silently deny the rest of it. The exclusion has already been applied to the
 * amount via the eligible set, and the item evaluation stays in the trace.
 *
 * When the fact gates terminated, their decision is authoritative and the
 * blocking rule is reported as the reason - including when that rule is an
 * item rule, which is the correct answer for a basket that is entirely
 * ineligible.
 */
function decidingRule(
  input: ResolveInput,
  evaluations: readonly RuleEvaluation[],
): RuleEvaluation | null {
  if (input.gateResult.terminal && input.gateResult.decidingRuleId !== null) {
    return (
      evaluations.find((rule) => rule.ruleId === input.gateResult.decidingRuleId) ?? null
    );
  }
  return precedenceFold(evaluations.filter((rule) => rule.scope === 'order'));
}

function decisionFrom(winner: RuleEvaluation | null): Decision {
  if (winner === null || winner.outcome === 'pass') {
    // Nothing reached a conclusion: a person decides, never an automatic approval.
    return 'escalated';
  }
  if (winner.outcome === 'deny') {
    return 'denied';
  }
  if (winner.outcome === 'escalate') {
    return 'escalated';
  }
  return 'approved';
}

/** The result of consulting the discretion layer. */
interface Softened {
  readonly decision: Decision;
  /** The amount a partial-refund discretion authorised, when that was the recommendation. */
  readonly partialAmountCents: number | null;
  /** True when discretion changed the outcome. */
  readonly applied: boolean;
  /** The audit records for the adjustment, in the order they should read. */
  readonly overrides: OverrideRecord[];
}

/**
 * Consult the discretion layer and apply its recommendation.
 *
 * The layer only ever softens an escalation, so a `denied` base decision passes
 * through untouched - only a person can overturn a denial (`overrideGuard.ts`).
 * Every adjustment is recorded as an override so the audit trail shows both the
 * policy outcome and the discretion that softened it.
 */
function applyDiscretion(
  baseDecision: Decision,
  winner: RuleEvaluation | null,
  evaluations: readonly RuleEvaluation[],
  input: ResolveInput,
): Softened {
  const recommendation = recommendDiscretion({
    baseDecision,
    winner,
    trace: evaluations,
    order: input.order,
    customer: input.customer ?? null,
    eligibleAmountCents: input.gateResult.eligibleAmountCents,
    orderTotalCents: input.orderTotalCents,
    extraction: input.extraction ?? null,
    grounding: input.grounding,
    config: input.discretion ?? DEFAULT_DISCRETION,
  });

  if (recommendation.kind === 'none') {
    return { decision: baseDecision, partialAmountCents: null, applied: false, overrides: [] };
  }

  const decision = decisionFromRecommendation(recommendation.kind);
  const partialAmountCents = recommendation.kind === 'partial_refund' ? recommendation.amountCents : null;
  return {
    decision,
    partialAmountCents,
    applied: true,
    overrides: [
      {
        code: discretionOverrideCode(recommendation.kind),
        detail: discretionDetail(recommendation, winner, input),
        aiProposal: input.aiProposal,
      },
    ],
  };
}

function discretionOverrideCode(kind: DecisionKind): OverrideCode {
  if (kind === 'approve') {
    return 'discretion_approve';
  }
  if (kind === 'partial_refund') {
    return 'discretion_partial_refund';
  }
  if (kind === 'exchange') {
    return 'discretion_exchange';
  }
  return 'discretion_store_credit';
}

function discretionDetail(
  recommendation: DiscretionRecommendation,
  winner: RuleEvaluation | null,
  input: ResolveInput,
): string {
  const reason = winner === null ? 'no rule concluded' : `${winner.ruleId} (${winner.policyRef})`;
  const eligible = formatCents(input.gateResult.eligibleAmountCents);
  if (recommendation.kind === 'approve') {
    return `discretion approved ${eligible} that ${reason} had escalated for review`;
  }
  if (recommendation.kind === 'partial_refund') {
    return `discretion approved ${formatCents(recommendation.amountCents)} of ${eligible} that ${reason} had escalated; the remainder needs a person`;
  }
  if (recommendation.kind === 'exchange') {
    return `discretion offered an exchange instead of a refund; ${reason} had escalated`;
  }
  return `discretion offered store credit instead of a refund; ${reason} had escalated`;
}

/**
 * What actually gets paid.
 *
 * Only an approval authorises money, and a partial refund authorises a reduced
 * amount. A denial pays nothing, and an escalation authorises nothing either: it
 * is a request for a person to look, so putting the eligible figure in the payable
 * field would mean a $700 machine is queued for payment on a decision that a human
 * has not yet made. Whatever consumes `refundAmountCents` is then reading exactly
 * the right thing - money that may leave the till - and the amount a reviewer is
 * looking at is on `eligibleAmountCents` and the trace.
 */
function amountFor(decision: Decision, input: ResolveInput, partialAmountCents: number | null): number {
  if (decision === 'approved') {
    return capToDispute(input);
  }
  if (decision === 'partial_refund') {
    const base = capToDispute(input);
    return partialAmountCents === null ? base : Math.min(partialAmountCents, base);
  }
  return 0;
}

function capToDispute(input: ResolveInput): number {
  const ceiling = input.disputeCeilingCents;
  const eligible = input.gateResult.eligibleAmountCents;
  return ceiling === null ? eligible : Math.min(ceiling, eligible);
}

/**
 * Records the cap in the audit trail whenever it bit.
 *
 * A reduction in what we pay is exactly the kind of thing an auditor needs to
 * see stated rather than inferred from two numbers that happen to differ.
 */
function ceilingOverride(input: ResolveInput, amount: number): OverrideRecord[] {
  if (input.disputeCeilingCents === null) {
    return [];
  }
  const detail = describeCeiling(input.disputeCeilingCents, input.gateResult.eligibleAmountCents);
  if (detail === null) {
    return [];
  }
  return [
    {
      code: 'amount_limited_to_disputed_items',
      detail: `${detail}; paid ${formatCents(amount)}`,
      aiProposal: input.aiProposal,
    },
  ];
}

/** Records where the model's opinion and the policy disagreed. */
function reconcile(
  input: ResolveInput,
  decision: Decision,
  amount: number,
): OverrideRecord[] {
  const overrides: OverrideRecord[] = [];
  const proposal = input.aiProposal;

  if (proposal !== null && proposal.suggestedDecision !== decision) {
    overrides.push({
      code: overrideCodeFor(proposal.suggestedDecision, decision),
      detail: `model proposed ${proposal.suggestedDecision} of ${formatCents(proposal.suggestedAmountCents)}; resolver returned ${decision}`,
      aiProposal: proposal,
    });
  }

  if (decision === 'approved' && proposal !== null && proposal.suggestedAmountCents !== amount) {
    overrides.push({
      code: 'amount_clamped_to_order_value',
      detail: `model referenced ${formatCents(proposal.suggestedAmountCents)}; resolver used the order-derived amount ${formatCents(amount)}`,
      aiProposal: proposal,
    });
  }

  if (decision === 'denied' && amount !== 0) {
    overrides.push({
      code: 'amount_zeroed_on_deny',
      detail: 'refund amount forced to $0 by a denial',
      aiProposal: proposal,
    });
  }

  overrides.push(...unpayableOverride(input, decision));
  overrides.push(...ungroundingOverrides(input, decision));
  return overrides;
}

/**
 * States the amount a human is being asked to rule on.
 *
 * The payable amount on an escalation is $0, which on its own would hide the
 * stakes. A reviewer opening the record needs to see that the claim is for
 * $700.00 without that figure ever looking payable, so it is recorded here as
 * what it is - a request under review - and stays on `eligibleAmountCents`.
 */
function unpayableOverride(input: ResolveInput, decision: Decision): OverrideRecord[] {
  if (decision !== 'escalated' || input.gateResult.eligibleAmountCents === 0) {
    return [];
  }
  return [
    {
      code: 'amount_not_payable_until_reviewed',
      detail: `escalated rather than approved: ${formatCents(input.gateResult.eligibleAmountCents)} is under review and is not authorised for payment`,
      aiProposal: input.aiProposal,
    },
  ];
}

function ungroundingOverrides(input: ResolveInput, decision: Decision): OverrideRecord[] {
  if (input.grounding === null || input.grounding.grounded || decision !== 'escalated') {
    return [];
  }
  return [
    {
      code: 'ungrounded_reason_escalated' as const,
      detail: `no evidence in the customer's message supported the extracted reason; ${input.grounding.rejectedQuotes.length} quote(s) rejected`,
      aiProposal: input.aiProposal,
    },
  ];
}

function overrideCodeFor(suggested: Decision, actual: Decision): OverrideCode {
  if (suggested === 'approved' && actual === 'denied') {
    return 'ai_proposed_approve_clamped_to_deny';
  }
  if (suggested === 'approved' && actual === 'escalated') {
    return 'ai_proposed_approve_clamped_to_escalate';
  }
  return 'ai_proposal_rejected';
}

function summarise(
  decision: Decision,
  winner: RuleEvaluation | null,
  input: ResolveInput,
  amount: number,
  discretionApplied: boolean,
): string {
  if (winner === null) {
    return `${VERB[decision]}: no policy rule reached a conclusion, so a person must decide.`;
  }
  const rulePart = `${winner.ruleId} (${winner.policyRef}): ${winner.evidence}`;
  const amountPart = decision === 'denied' ? 'No refund will be issued.' : `${formatCents(amount)}.`;
  const orderPart = input.orderId === null ? '' : ` Order ${input.orderId}.`;
  const discretionPart = discretionApplied
    ? ' Softened by the discretion layer within pre-authorised bounds.'
    : '';
  return `${VERB[decision]} under ${rulePart}${orderPart} ${amountPart}${discretionPart}`;
}
