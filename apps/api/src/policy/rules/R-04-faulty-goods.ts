import { evaluation, hasGroundedFault, groundedClaimLineIds, pass, type PolicyContext, type PolicyRule } from '../types.js';
import { formatCents, sumPrices } from '../../lib/money.js';

/**
 * R-04 - faulty goods. The only rule that can approve a request on the strength
 * of what the customer said, which is exactly why it demands a grounded quote
 * rather than a confident reason code.
 *
 * With a per-line extraction (`lineClaims`) it approves *only the claimed lines
 * whose own reason is grounded* - so "the mug arrived broken and the lamp shade
 * is cracked", where only the mug's words are verified, pays the mug and leaves
 * the lamp to R-12. Without one (the legacy single-reason reading) it behaves
 * exactly as it always has: one grounded reason approves the eligible set.
 *
 * Item-scoped, and the approval is item-scoped too: it lists the lines it
 * approves, the resolver folds that list into the payable amount, and it can
 * never outrank an order-scoped refusal of the whole request.
 */
export const R04FaultyGoods: PolicyRule = {
  id: 'R-04',
  title: 'Damaged or incorrect goods',
  ruleClass: 'eligibility',
  scope: 'item',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §5.1',
  summary: 'Verified damage or an incorrect item qualifies for automatic approval.',
  evaluate(context) {
    const groundedLines = groundedClaimLineIds(context);
    return groundedLines === undefined ? legacyApproval(this, context) : perLineApproval(this, context, groundedLines);
  },
};

function perLineApproval(rule: PolicyRule, context: PolicyContext, groundedLines: readonly string[]): ReturnType<PolicyRule['evaluate']> {
  if (groundedLines.length === 0) {
    return pass(rule, 'no claimed line has a grounded damage or incorrect-item claim');
  }
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: 'item',
    policyRef: rule.policyRef,
    outcome: 'approve',
    evidence: `grounded per-line claim${groundedLines.length === 1 ? '' : 's'} on ${namesOf(context, groundedLines)} covering ${formatCents(
      linePrices(context, groundedLines),
    )}`,
    itemIds: groundedLines,
  });
}

function legacyApproval(rule: PolicyRule, context: PolicyContext): ReturnType<PolicyRule['evaluate']> {
  if (!hasGroundedFault(context)) {
    return pass(rule, 'no grounded damage or incorrect-item claim');
  }
  if (context.eligibleAmountCents === 0) {
    return pass(rule, 'no eligible items remain to refund');
  }
  const { extraction, grounding } = context;
  const confidence = extraction?.confidence ?? 0;
  const quotes = grounding?.verifiedQuotes.length ?? 0;
  // Order-scoped by construction, whatever this rule declares: a whole-message
  // approval is a verdict on the request, not an adjustment to a line.
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: 'order',
    policyRef: rule.policyRef,
    outcome: 'approve',
    evidence: `grounded "${extraction?.reason}" claim (confidence ${confidence.toFixed(2)}, ${quotes} verified quote(s)) covering ${formatCents(context.eligibleAmountCents)} of eligible items`,
  });
}

function namesOf(context: PolicyContext, itemIds: readonly string[]): string {
  return (context.order?.items ?? [])
    .filter((item) => itemIds.includes(item.id))
    .map((item) => item.name)
    .join(' and ');
}

function linePrices(context: PolicyContext, itemIds: readonly string[]): number {
  return sumPrices(
    (context.order?.items ?? [])
      .filter((item) => itemIds.includes(item.id))
      .map((item) => item.unitPriceCents * item.quantity),
  );
}