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
import { pendingCentsForOrder, settledCentsForOrder } from '../db/refundLedger.js';
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
  /**
   * The lowest claim confidence the engine will act on without asking a person.
   *
   * Undefined means the `AI_MIN_CONFIDENCE` default. Read only by the confidence
   * guard, and only ever to stop a *paid* decision.
   */
  readonly minConfidence?: number | undefined;
}

/**
 * The claim confidence below which a request goes to a person.
 *
 * Defaulted here as well as in the environment schema, so a caller that builds a
 * `ResolveInput` by hand - which is most of the tests - gets the production behaviour
 * rather than an accidental exemption from it.
 */
const DEFAULT_MIN_CONFIDENCE = 0.5;

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
 * What arrives here is *data*. The intake layer hands over a reading of what the
 * customer said - a reason, a condition, the figure they asked for - and a
 * `AiProposal` from any caller that has one, but nothing that could be read as a
 * request to approve. Both can be recorded, compared against what the policy
 * concluded, and reported in the audit trail; neither can change the outcome.
 * Precedence is DENY > ESCALATE > APPROVE, and when no rule reaches a conclusion
 * the safe default is to escalate, never to approve.
 */
export function resolve(input: ResolveInput): RefundDecision {
  const evaluations = [
    ...input.intakeEvaluations,
    ...input.gateResult.evaluations,
    ...input.reasonEvaluations,
  ];
  const winner = decidingRule(input, evaluations);
  const baseDecision = decisionFrom(winner);
  // The fold always returns a rule, even when every one of them passed, so the
  // deciding rule and the *concluding* rule are not the same thing. Only the
  // second may be named as the reason for a decision: naming the rule that merely
  // sorted first would report an ordinary delivery complaint as settled under the
  // policy-override clause, which is both self-contradictory ("under R-14: no
  // policy-override signal") and alarming in the one field an auditor reads.
  const concluded = concludingRule(winner);
  // The floor is a precondition for money, whoever is proposing the money - and the
  // discretion layer proposes money. Gating only the base decision would leave the
  // obvious hole: an escalation that the layer would have softened into a partial
  // refund, on a claim the model does not stand behind.
  const gated = confidenceGate(baseDecision, concluded, input);
  const softened = applyDiscretion(gated.decision, gated.winner, evaluations, input);
  const decision = softened.decision;
  const requested = amountFor(decision, input, softened.partialAmountCents);
  const { decision: payable, amount, balanceNote } = settledAgainstBalance(decision, requested, input);
  const ceiling = ceilingOverride(input, amount);
  const overrides = [
    ...softened.overrides,
    ...gated.overrides,
    ...balanceNote,
    ...reconcile(input, payable, amount, evaluations),
    ...ceiling,
  ];
  assertAmountSane(amount, input.orderTotalCents);

  return {
    decision: payable,
    refundAmountCents: amount,
    eligibleAmountCents: input.gateResult.eligibleAmountCents,
    currency: 'USD',
    summary: summarise(decision, gated.winner, input, amount, softened.applied),
    policyRef: concluded?.policyRef ?? 'REFUND_POLICY.md §9',
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
/**
 * The rule that actually reached a conclusion.
 *
 * `precedenceFold` returns the strongest evaluation, which on a clean request is
 * the first rule that passed. That is the right input to the decision and the
 * wrong input to the audit trail.
 */
function concludingRule(winner: RuleEvaluation | null): RuleEvaluation | null {
  return winner === null || winner.outcome === 'pass' ? null : winner;
}

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
  // Asked what the layer *would* have done before being told not to. A floor that
  // cannot say whether it stopped anything is indistinguishable from a floor that
  // did not fire: the request looks the same whether the escalation was always going
  // to stand or whether the reading was what stopped the money.
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

  // Nothing to soften is nothing to block. Checked before the floor, because a
  // refusal that the layer would not have touched has to stay refused: the floor
  // decides whether money may move, and it must never be a way to reopen one.
  if (recommendation.kind === 'none') {
    return { decision: baseDecision, partialAmountCents: null, applied: false, overrides: [] };
  }

  if (!confidenceAllowsPayment(input)) {
    // The layer would have paid, and the floor is what stops it. Recorded, because a
    // stopped softening is worth more to an operator than a silent one.
    return {
      decision: 'escalated',
      partialAmountCents: null,
      applied: false,
      overrides: [lowConfidenceRecord(input, input.extraction?.confidence ?? 0, input.minConfidence ?? DEFAULT_MIN_CONFIDENCE)],
    };
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
  const eligible = formatCents(input.gateResult.eligibleAmountCents);
  // Two clauses rather than one interpolated phrase, because the second reads as
  // nonsense when there is no rule to name - "no rule concluded had escalated"
  // is a sentence nobody can act on, in the field that says why the money moved.
  const because =
    winner === null
      ? 'no policy rule reached a conclusion, so the request escalated by default'
      : `${winner.ruleId} (${winner.policyRef}) escalated it`;

  if (recommendation.kind === 'approve') {
    return `discretion approved ${eligible} that ${because}`;
  }
  if (recommendation.kind === 'partial_refund') {
    return `discretion approved ${formatCents(recommendation.amountCents)} of ${eligible} that ${because}; the remainder needs a person`;
  }
  if (recommendation.kind === 'exchange') {
    return `discretion offered an exchange instead of a refund that ${because}`;
  }
  return `discretion offered store credit instead of a refund that ${because}`;
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

/**
 * What is still refundable on this order.
 *
 * The same arithmetic as R-06b, which asks whether anything is *left*; this asks
 * how much. Duplicated deliberately rather than exported from the rule, because a
 * rule returns an evaluation and this needs the figure - but both read the order's
 * own count and the ledger, and both take the larger of the two so neither
 * under-counts money that has already gone.
 *
 * Null when there is no order to count against, which is the case in most unit
 * tests; the cap is then simply not applied.
 */
function remainingBalanceCents(input: ResolveInput): number | null {
  if (input.order === null) {
    return null;
  }
  const settled = Math.max(input.order.refundedCents, settledCentsForOrder(input.db, input.order.id));
  const pending = pendingCentsForOrder(input.db, input.order.id);
  // `orderTotalCents` rather than `order.totalCents`: it is the figure the rest of
  // this file already treats as authoritative for "what was paid" - `assertAmountSane`
  // bounds the amount by it and the ceiling is measured against it. Two sources for
  // one fact is how a cap and a sanity check end up disagreeing about the same order.
  return input.orderTotalCents - settled - pending;
}

/**
 * An approval is capped to what is left to give back.
 *
 * Before this, the amount came from the claim alone: eligible, capped to the
 * disputed lines. On an order that has already been partly refunded - a $100 order
 * with $40 gone - a $100 claim produced a $100 authorisation, and the ledger then
 * refused it. The customer saw a 409 with no request row, so a perfectly valid
 * claim for the remaining $60 never reached the queue at all.
 *
 * Two outcomes, both visible:
 *
 *  - **Some remains.** The approval is reduced to it and reported as a partial
 *    refund, because the customer asked for more than is coming and saying
 *    "approved" for the smaller figure would be the wrong sentence for that.
 *  - **Nothing remains.** The request escalates with a stated reason. It cannot
 *    become an approval for $0.00, which reads as a success that moved no money.
 */
function settledAgainstBalance(
  decision: Decision,
  requested: number,
  input: ResolveInput,
): { decision: Decision; amount: number; balanceNote: readonly OverrideRecord[] } {
  const none: readonly OverrideRecord[] = [];
  const pays = decision === 'approved' || decision === 'partial_refund';
  if (!pays) {
    return { decision, amount: requested, balanceNote: none };
  }

  const remaining = remainingBalanceCents(input);
  if (remaining === null) {
    return { decision, amount: requested, balanceNote: none };
  }

  // Nothing left. Not an approval for $0.00, which reads as a success that moved no
  // money - the customer believes they are done and the business is out of pocket.
  if (remaining <= 0) {
    return { decision: 'escalated', amount: 0, balanceNote: none };
  }

  if (requested <= remaining) {
    return { decision, amount: requested, balanceNote: none };
  }

  // Reduced, not refused: the claim is valid and there is simply less left than the
  // customer asked for, so the amount is reported as a reduction and the customer is
  // told the remainder is not coming.
  return {
    decision: 'partial_refund',
    amount: remaining,
    balanceNote: [
      {
        code: 'amount_limited_to_remaining_balance',
        detail:
          `capped to ${formatCents(remaining)}, the amount still refundable on this order; ` +
          `${formatCents(requested - remaining)} of the claim cannot be refunded`,
        aiProposal: input.aiProposal,
      },
    ],
  };
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
  evaluations: readonly RuleEvaluation[],
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

  overrides.push(...claimAmountOverride(input, decision, amount));
  overrides.push(...discardedClaimOverride(input, evaluations));
  overrides.push(...unpayableOverride(input, decision));
  overrides.push(...ungroundingOverrides(input, decision));
  return overrides;
}

/**
 * Whether a claim confident enough may move money, by anyone.
 *
 * The single question, asked once, because the answer has to hold for the base
 * policy *and* for the discretion layer: two thresholds that could disagree would
 * mean the floor is only as good as the path that checked it last.
 */
function confidenceAllowsPayment(input: ResolveInput): boolean {
  const confidence = input.extraction?.confidence ?? null;
  return confidence === null || confidence >= (input.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
}

/**
 * A claim the model does not stand behind is not a claim.
 *
 * `confidence` is self-reported, which is exactly why it is used this way: the engine
 * does not *trust* the number, it refuses to let a low one authorise money. A model
 * saying "I am guessing" is not evidence of anything, and paying out on a guess is the
 * one failure this system is built to make impossible - so a low reading sends the
 * request to a person and says so.
 *
 * Two properties keep it safe to have at all:
 *
 *  - **It can only escalate.** `paid` below is deliberately narrow: a claim that
 *    would be *denied* stays denied, because a refusal needs no confidence and this
 *    must never be a way to unlock an approval.
 *  - **It is a floor on the decision, not a filter on the evidence.** The claim is
 *    still recorded, still grounded the same way, and still visible in the audit; it
 *    simply does not get to end the conversation by itself.
 *
 * It also runs *before* discretion, so a low-confidence claim cannot be softened into
 * a partial refund or an exchange either. The layer's own floor is a separate number
 * for a separate reason and neither can raise the other's ceiling.
 */
function confidenceGate(
  baseDecision: Decision,
  winner: RuleEvaluation | null,
  input: ResolveInput,
): { decision: Decision; winner: RuleEvaluation | null; overrides: readonly OverrideRecord[] } {
  const floor = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const confidence = input.extraction?.confidence ?? null;
  const paid = baseDecision === 'approved' || baseDecision === 'partial_refund';

  if (confidence === null || !paid || confidence >= floor) {
    return { decision: baseDecision, winner, overrides: [] };
  }

  return { decision: 'escalated', winner, overrides: [lowConfidenceRecord(input, confidence, floor)] };
}

/**
 * The audit line for a claim held back on confidence.
 *
 * Written even when the outcome was already an escalation, because the two are
 * different events: "the policy would have paid this but nobody stood behind the
 * reading" is not the same as "the policy refused this anyway", and only one of them
 * says the model needs a better prompt.
 */
function lowConfidenceRecord(
  input: ResolveInput,
  confidence: number,
  floor: number,
): OverrideRecord {
  return {
    code: 'low_confidence_claim_escalated',
    detail: `the model read this claim at ${confidence.toFixed(2)} confidence, below the ${floor.toFixed(2)} floor; a person decides instead`,
    aiProposal: input.aiProposal,
  };
}

/**
 * States the gap between the figure the customer asked for and the one paid.
 *
 * The intake layer no longer proposes an outcome, but the customer still named a
 * number and the policy still produced a different one. That gap is the thing an
 * auditor needs stated rather than inferred: S-18 is a message demanding $9000
 * that the engine paid $130 on, and nothing else in the record says the demand
 * was read and refused. Recorded only when the claim actually named a figure, so
 * an approval that simply matched the request stays a clean row.
 */
function claimAmountOverride(input: ResolveInput, decision: Decision, amount: number): OverrideRecord[] {
  const claimed = input.extraction?.claimedAmountCents ?? null;
  if (claimed === null) {
    return [];
  }
  if (decision === 'approved' || decision === 'partial_refund') {
    if (claimed === amount) {
      return [];
    }
    return [
      {
        code: 'amount_clamped_to_order_value',
        detail: `the customer asked for ${formatCents(claimed)}; the policy authorised ${formatCents(amount)}`,
        aiProposal: input.aiProposal,
      },
    ];
  }
  if (decision === 'denied') {
    return [
      {
        code: 'amount_zeroed_on_deny',
        detail: `the customer asked for ${formatCents(claimed)}; the denial authorised $0.00`,
        aiProposal: input.aiProposal,
      },
    ];
  }
  // An escalation is already recorded as "under review and not authorised".
  return [];
}

/**
 * Records that a claim was read and then thrown away.
 *
 * R-14 is the only integrity rule, and it is the case where the request must not
 * be decided on what the model read. The audit trail has to show the read
 * happened and was discarded, because "denied, no explanation" and "denied after
 * ignoring an injected instruction" are different events and only one of them is
 * the system working.
 */
function discardedClaimOverride(
  input: ResolveInput,
  evaluations: readonly RuleEvaluation[],
): OverrideRecord[] {
  if (input.extraction === null || input.extraction === undefined) {
    return [];
  }
  const integrity = evaluations.find(
    (rule) => rule.ruleClass === 'integrity' && rule.outcome !== 'pass',
  );
  if (integrity === undefined) {
    return [];
  }
  return [
    {
      code: 'untrusted_extraction_discarded',
      detail: `${integrity.ruleId} (${integrity.policyRef}) flagged the request; the claim the model read was discarded and the decision was made from order facts alone`,
      aiProposal: input.aiProposal,
    },
  ];
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
    const amountPart = decision === 'denied' ? 'No refund will be issued.' : `${formatCents(amount)}.`;
    return `${VERB[decision]}: no policy rule reached a conclusion, so the request escalated by default. ${amountPart}${discretionPart(discretionApplied)}`;
  }
  const rulePart = `${winner.ruleId} (${winner.policyRef}): ${winner.evidence}`;
  const amountPart = decision === 'denied' ? 'No refund will be issued.' : `${formatCents(amount)}.`;
  const orderPart = input.orderId === null ? '' : ` Order ${input.orderId}.`;
  return `${VERB[decision]} under ${rulePart}${orderPart} ${amountPart}${discretionPart(discretionApplied)}`;
}

/** The sentence that says the discretion layer was what changed the outcome. */
function discretionPart(discretionApplied: boolean): string {
  return discretionApplied ? ' Softened by the discretion layer within pre-authorised bounds.' : '';
}
