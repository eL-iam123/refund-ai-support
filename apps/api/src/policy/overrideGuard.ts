import type { Decision, RuleEvaluation, RuleId } from '@refund/shared';

/**
 * What a human is allowed to overturn.
 *
 * An override exists because a person knows things the database does not - a
 * warehouse called to say an item was not actually sealed, a goodwill decision
 * nobody wrote a rule for. That is a real capability and it is worth having.
 *
 * It is also a way around every control in this system, so the power is
 * graduated by how dangerous the reversal actually is:
 *
 *   - Turning a denial into a payment is always deliberate. If the policy
 *     refused for a hard financial or integrity reason, the request has to carry
 *     an explicit acknowledgement, so the console can ask for it and the audit
 *     trail can show it was given.
 *   - Where the reversal is not merely discouraged but *impossible* - the order
 *     has already been refunded in full - it is refused outright. A button that
 *     records a second payment against money that has already gone out is not a
 *     control, and no note justifies it.
 *
 * Note that a human can still make the right call on every one of these. Nothing
 * here is a policy judgement about the customer; it is a judgement about whether
 * the person pressing the button had noticed what they were undoing.
 */

/** Denials that exist to stop money going out, not to triage a queue. */
export const HARD_BLOCK_RULES: ReadonlySet<RuleId> = new Set<RuleId>([
  'R-01', // outside the absolute refund window
  'R-02', // final sale
  'R-05', // digital goods already downloaded
  'R-06', // payment already settled or refunded
  'R-06b', // no refundable balance remains after settled and pending refunds
  'R-14', // policy override attempt
]);

/**
 * A refusal, carrying its own explanation.
 *
 * The message lives here rather than at the route so that whoever renders it -
 * HTTP today, a CLI tomorrow - cannot accidentally show a bare "no" to somebody
 * trying to do the right thing by a customer.
 */
export type OverrideRefusal =
  | { readonly kind: 'impossible'; readonly message: string; readonly ruleIds: readonly RuleId[] }
  | { readonly kind: 'needs_acknowledgement'; readonly message: string; readonly ruleIds: readonly RuleId[] };

export interface OverrideAttempt {
  readonly current: Decision;
  readonly next: Decision;
  readonly trace: readonly RuleEvaluation[];
  /** True when the order has already been refunded in full. */
  readonly alreadyFullyRefunded: boolean;
  readonly acknowledged: boolean;
}

/** The rule ids that denied this request, in trace order, de-duplicated. */
export function hardBlockRuleIds(trace: readonly RuleEvaluation[]): readonly RuleId[] {
  const found: RuleId[] = [];
  for (const evaluation of trace) {
    if (evaluation.outcome === 'deny' && HARD_BLOCK_RULES.has(evaluation.ruleId) && !found.includes(evaluation.ruleId)) {
      found.push(evaluation.ruleId);
    }
  }
  return found;
}

/**
 * Whether an override may proceed.
 *
 * The test is whether the override *authorises money*, and only `approved` does.
 * Everything else is free and should stay that way: denying a request, or
 * routing a refused one to a person who can look again, costs the business
 * nothing and gives the customer another chance. An admin should never be
 * stopped from tightening an outcome, and asking them to acknowledge a "hard
 * block" they are not reversing would be a misleading prompt as well as an
 * obstacle.
 */
export function checkOverride(attempt: OverrideAttempt): OverrideRefusal | null {
  // Only an override that *turns a refusal into a payment* is restricted. Denying,
  // re-escalating, or re-confirming an approval that is already approved move no
  // money, so they are never blocked.
  if (attempt.next !== 'approved' || attempt.current === 'approved') {
    return null;
  }

  // Refused outright: the money this would authorise has already left, so
  // approving it is not a judgement call but a double payment.
  if (attempt.alreadyFullyRefunded) {
    return {
      kind: 'impossible',
      ruleIds: hardBlockRuleIds(attempt.trace),
      message:
        'this order has already been refunded in full, so approving it would authorise a second payment. ' +
        'Issue a new order, or refund the difference through the normal payment process instead.',
    };
  }

  const ruleIds = hardBlockRuleIds(attempt.trace);
  if (ruleIds.length > 0 && !attempt.acknowledged) {
    return {
      kind: 'needs_acknowledgement',
      ruleIds,
      message:
        `the policy refused this request on ${ruleIds.join(', ')}. Overturning that is allowed, but it has ` +
        'to be deliberate: resend with acknowledgeHardBlock set to true and a note saying why.',
    };
  }

  return null;
}
