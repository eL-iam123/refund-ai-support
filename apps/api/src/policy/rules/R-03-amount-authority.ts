import { HUMAN_REVIEW_THRESHOLD_CENTS } from '../constants.js';
import { escalate, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-03 - amount authority. Evaluated against the *order total*, before
 * item-level denials are applied, so a large order cannot be split under the
 * threshold by excluding its expensive lines. The eligible amount is what a
 * reviewer would authorise, so it is reported alongside; the threshold itself
 * is a fact about the order, not about which items happen to survive.
 */
export const R03AmountAuthority: PolicyRule = {
  id: 'R-03',
  title: 'Human review above threshold',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §4.1',
  summary: `Refunds against orders over ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} require human review.`,
  evaluate(context) {
    if (context.orderTotalCents === 0) {
      return pass(this, 'no order total to review');
    }
    if (context.orderTotalCents > HUMAN_REVIEW_THRESHOLD_CENTS) {
      return escalate(
        this,
        `order total of ${formatCents(context.orderTotalCents)} exceeds the ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} review threshold`,
      );
    }
    return pass(
      this,
      `order total of ${formatCents(context.orderTotalCents)} is within the review threshold`,
    );
  },
};
