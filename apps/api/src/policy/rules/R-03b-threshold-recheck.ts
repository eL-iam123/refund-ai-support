import { pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-03b - item-denial annotation. Not a decision: it fires when item-level
 * denials reduced the eligible amount below the order total, so the reduction
 * that a reviewer needs to see is stated in the audit trail instead of looking
 * accidental. The §4.1 review threshold is order-scoped (R-03) and is not
 * changed by these denials, whatever the remainder happens to be.
 */
export const R03bThresholdRecheck: PolicyRule = {
  id: 'R-03b',
  title: 'Eligible remainder after item-level denials',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §4.2',
  summary: 'Records the eligible amount after item-level denials reduce it below the order total.',
  evaluate(context) {
    const { eligibleAmountCents, orderTotalCents, blockedItems } = context;
    if (eligibleAmountCents < orderTotalCents && blockedItems.length > 0) {
      return pass(
        this,
        `${formatCents(orderTotalCents)} order total reduced to ${formatCents(eligibleAmountCents)} eligible by ${blockedItems.length} blocked item(s)`,
      );
    }
    return pass(this, 'eligible amount not reduced by item-level denials');
  },
};
