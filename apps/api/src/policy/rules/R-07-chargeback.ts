import { escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-07 - open chargeback. Risk class: escalates, never denies. The money is
 * already moving backwards through the bank, so a refund here risks paying
 * twice - but only a human should decide that.
 */
export const R07ChargebackOpen: PolicyRule = {
  id: 'R-07',
  title: 'Open chargeback on the order',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §6.1',
  summary: 'An in-flight chargeback means a refund could pay the customer twice.',
  evaluate(context) {
    if (context.order?.paymentState === 'chargeback_open') {
      return escalate(this, 'card issuer has an open chargeback on this order');
    }
    return pass(this, 'no open chargeback');
  },
};
