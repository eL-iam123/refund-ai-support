import { deny, pass, type PolicyRule } from '../types.js';

/** R-10 - subscriptions are a billing concern, not a refund. */
export const R10Subscription: PolicyRule = {
  id: 'R-10',
  title: 'Subscription and renewal charges',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.4',
  summary: 'Recurring and renewal charges are handled by billing, not refunds.',
  evaluate(context) {
    if (context.order?.isSubscription === true) {
      return deny(this, 'order is a subscription or renewal charge');
    }
    return pass(this, 'not a subscription charge');
  },
};
