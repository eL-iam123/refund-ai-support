import { STANDARD_WINDOW_DAYS } from '../constants.js';
import { escalate, hasGroundedFault, pass, type PolicyRule } from '../types.js';

/**
 * R-01b - standard window. Requests older than 30 days survive the fact gates
 * only if a grounded fault claim justifies the extended window; otherwise a
 * human decides. Requires the model, because it needs the claimed reason.
 */
export const R01bStandardWindow: PolicyRule = {
  id: 'R-01b',
  title: 'Standard refund window',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §3.1',
  summary: `Claims older than ${STANDARD_WINDOW_DAYS} days need a verified fault or human review.`,
  evaluate(context) {
    const order = context.order;
    if (order === null) {
      return pass(this, 'no order resolved; window not applicable');
    }
    if (order.ageDays <= STANDARD_WINDOW_DAYS) {
      return pass(this, `${order.ageDays} days old, inside the standard window`);
    }
    if (hasGroundedFault(context)) {
      return pass(this, `${order.ageDays} days old but grounded fault claim supports the extended window`);
    }
    return escalate(
      this,
      `${order.ageDays} days old, outside the ${STANDARD_WINDOW_DAYS}-day standard window with no verifiable fault`,
    );
  },
};
