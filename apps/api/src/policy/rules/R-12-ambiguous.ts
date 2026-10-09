import { evaluation, groundedClaimLineIds, claimedLineIds, pass, type PolicyContext, type PolicyRule } from '../types.js';

/**
 * R-12 - nothing usable to decide on. The safety valve: when the model cannot
 * point at words in the customer's message that support a reason, the request
 * goes to a person rather than being approved on a guess.
 *
 * With a per-line extraction, "nothing usable" is measured *per line*. The
 * lines whose claim failed verification are escalated; the lines whose claim
 * grounded are left for R-04 to approve. So a mixed basket - "the mug arrived
 * broken and the lamp shade is cracked" - pays the mug and sends only the lamp
 * to review, instead of One ungrounded line dragging the entire request there.
 *
 * Without `lineClaims` (the legacy single-reason reading) it keeps its
 * whole-message behaviour, verified here against the message as a whole and
 * emitted order-scoped so the legacy resolver fold still finds it.
 */
export const R12AmbiguousRequest: PolicyRule = {
  id: 'R-12',
  title: 'No grounded reason in the request',
  ruleClass: 'approval-authority',
  scope: 'item',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §5.3',
  summary: 'A request with no verifiable reason escalates to a human.',
  evaluate(context) {
    const groundedLines = groundedClaimLineIds(context);
    return groundedLines === undefined ? legacyEscalation(this, context) : perLineEscalation(this, context, groundedLines);
  },
};

function perLineEscalation(rule: PolicyRule, context: PolicyContext, groundedLines: readonly string[]): ReturnType<PolicyRule['evaluate']> {
  const eligible = new Set(context.eligibleItems.map((item) => item.id));
  const approved = new Set(groundedLines);
  const review = claimedLineIds(context).filter((itemId) => eligible.has(itemId) && !approved.has(itemId));
  if (review.length === 0) {
    return pass(
      rule,
      groundedLines.length === 0
        ? 'no claimed line is eligible for review'
        : 'every claimed line has a grounded reason',
    );
  }
  const names = (context.order?.items ?? [])
    .filter((item) => review.includes(item.id))
    .map((item) => item.name);
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: 'item',
    policyRef: rule.policyRef,
    outcome: 'escalate',
    evidence: `no evidence in the customer's message supports a claim on ${names.join(' and ')}`,
    itemIds: review,
  });
}

function legacyEscalation(rule: PolicyRule, context: PolicyContext): ReturnType<PolicyRule['evaluate']> {
  // Legacy whole-message reading. Order-scoped by construction: a verdict on
  // the request as a whole.
  const { extraction, grounding } = context;
  if (extraction === null) {
    return pass(rule, 'no extraction available');
  }
  if (grounding !== null && !grounding.grounded) {
    return legacyEscalate(
      rule,
      `no evidence in the customer's message supports "${extraction.reason}" (${grounding.rejectedQuotes.length} rejected quote(s))`,
    );
  }
  if (extraction.reason === 'other' || extraction.reason === 'none') {
    return legacyEscalate(rule, `request states no refund reason (extracted as "${extraction.reason}")`);
  }
  return pass(rule, `grounded reason "${extraction.reason}"`);
}

function legacyEscalate(rule: PolicyRule, why: string): ReturnType<PolicyRule['evaluate']> {
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: 'order',
    policyRef: rule.policyRef,
    outcome: 'escalate',
    evidence: why,
  });
}