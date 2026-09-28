import { HUMAN_REVIEW_THRESHOLD_CENTS } from '../constants.js';
import { pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-03b - threshold re-check. Not a decision: it fires only when item-level
 * denials reduced the amount and that reduction is exactly what brought the
 * request under the review threshold. Its whole purpose is to make the
 * S-17 reasoning visible in the audit trail instead of looking accidental.
 */
export const R03bThresholdRecheck: PolicyRule = {
  id: 'R-03b',
  title: 'Threshold re-check on eligible remainder',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §4.2',
  summary: 'Records that the amount threshold was re-evaluated after item-level denials.',
  evaluate(context) {
    const { eligibleAmountCents, orderTotalCents, blockedItems } = context;
    const reduced = eligibleAmountCents < orderTotalCents && blockedItems.length > 0;
    const overTotalButUnderThreshold =
      orderTotalCents > HUMAN_REVIEW_THRESHOLD_CENTS &&
      eligibleAmountCents <= HUMAN_REVIEW_THRESHOLD_CENTS;
    if (reduced && overTotalButUnderThreshold) {
      return pass(
        this,
        `${formatCents(orderTotalCents)} order total reduced to ${formatCents(eligibleAmountCents)} eligible by ${blockedItems.length} blocked item(s), which is under the review threshold`,
      );
    }
    return pass(this, 'amount threshold not affected by item-level denials');
  },
};
