import { HUMAN_REVIEW_THRESHOLD_CENTS } from '../constants.js';
import { escalate, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-03 - amount authority. Evaluated against the *eligible* amount, not the
 * order total, which is what makes R-03b meaningful.
 */
export const R03AmountAuthority: PolicyRule = {
  id: 'R-03',
  title: 'Human review above threshold',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §4.1',
  summary: `Refunds above ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} require human review.`,
  evaluate(context) {
    if (context.eligibleAmountCents === 0) {
      return pass(this, 'no eligible amount to review');
    }
    if (context.eligibleAmountCents > HUMAN_REVIEW_THRESHOLD_CENTS) {
      return escalate(
        this,
        `eligible refund of ${formatCents(context.eligibleAmountCents)} exceeds the ${formatCents(HUMAN_REVIEW_THRESHOLD_CENTS)} review threshold`,
      );
    }
    return pass(
      this,
      `eligible refund of ${formatCents(context.eligibleAmountCents)} is within the review threshold`,
    );
  },
};
