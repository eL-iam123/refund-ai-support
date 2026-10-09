import { HUMAN_REVIEW_THRESHOLD_CENTS } from '../constants.js';
import { disputedClaimCents, escalate, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-03 - amount authority. Evaluated against the amount the claim actually
 * puts at risk: the sum of the lines the customer pointed at when they named
 * lines, otherwise the order total. The check runs before item-level denials
 * are applied, so a claim cannot dodge the threshold by excluding its own
 * expensive lines; a whole-order claim keeps the order-total check, so it
 * cannot slip under by being narrowed to a token line instead.
 */
export const R03AmountAuthority: PolicyRule = {
  id: 'R-03',
  title: 'Human review above threshold',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §4.1',
  summary: `Refunds of more than ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} require human review.`,
  evaluate(context) {
    const disputed = disputedClaimCents(context);
    const amount = disputed ?? context.orderTotalCents;
    if (amount === 0) {
      return pass(this, 'no amount to review');
    }
    const basis =
      disputed !== null
        ? `claimed items total of ${formatCents(amount)}`
        : `order total of ${formatCents(amount)}`;
    if (amount > HUMAN_REVIEW_THRESHOLD_CENTS) {
      return escalate(
        this,
        `${basis} exceeds the ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} review threshold`,
      );
    }
    return pass(this, `${basis} is within the review threshold`);
  },
};
