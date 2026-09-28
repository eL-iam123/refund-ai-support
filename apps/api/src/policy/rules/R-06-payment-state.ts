import { deny, pass, type PolicyRule } from '../types.js';
import { FULLY_REFUNDED } from '../constants.js';

/** R-06 - payment state. A second refund on a settled order is not possible. */
export const R06PaymentState: PolicyRule = {
  id: 'R-06',
  title: 'Payment already settled or refunded',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.3',
  summary: 'Fully refunded, or unsettled, orders cannot be refunded again.',
  evaluate(context) {
    const order = context.order;
    if (order === null) {
      return pass(this, 'no order resolved; payment state not applicable');
    }
    if (order.paymentState === FULLY_REFUNDED && order.refundedCents >= order.totalCents) {
      return deny(
        this,
        `order already refunded in full (${order.refundedCents} of ${order.totalCents} cents)`,
      );
    }
    if (order.paymentState === 'pending') {
      return deny(this, 'payment has not settled yet');
    }
    return pass(this, `payment state "${order.paymentState}" permits a refund`);
  },
};
