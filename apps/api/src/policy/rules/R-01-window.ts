import { EXTENDED_WINDOW_DAYS } from '../constants.js';
import { deny, pass, type PolicyRule } from '../types.js';

/** R-01 - absolute outer refund window. Nothing is refundable past this. */
export const R01Window: PolicyRule = {
  id: 'R-01',
  title: 'Absolute refund window',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §3.2',
  summary: `Orders older than ${EXTENDED_WINDOW_DAYS} days from delivery are never refundable, whatever the reason.`,
  evaluate(context) {
    const order = context.order;
    if (order === null) {
      return pass(this, 'no order resolved; window not applicable');
    }
    if (order.ageDays > EXTENDED_WINDOW_DAYS) {
      return deny(
        this,
        `order delivered ${order.ageDays} days ago exceeds the ${EXTENDED_WINDOW_DAYS}-day absolute window`,
      );
    }
    return pass(this, `${order.ageDays} days old, within the ${EXTENDED_WINDOW_DAYS}-day window`);
  },
};
