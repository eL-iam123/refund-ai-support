import { deny, pass, type PolicyRule } from '../types.js';

/**
 * R-10 - subscriptions are a billing concern, not a refund.
 *
 * Item-scoped, like R-02: a recurring charge is a property of the product, so
 * only the subscription lines are excluded. The order-level `is_subscription`
 * flag says "this basket contains a subscription", which is a different claim -
 * a mixed basket of a coat and a monthly plan must not have the coat refused
 * because the plan is on the same order.
 */
export const R10Subscription: PolicyRule = {
  id: 'R-10',
  title: 'Subscription and renewal charges',
  ruleClass: 'eligibility',
  scope: 'item',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.4',
  summary: 'Recurring and renewal charges are handled by billing, not refunds.',
  evaluate(context) {
    const blocked = context.order?.items.filter((item) => item.isSubscription) ?? [];
    if (blocked.length === 0) {
      return pass(this, 'no subscription or renewal charges on this order');
    }
    return deny(
      this,
      `${blocked.length} subscription or renewal item(s): ${blocked.map((i) => i.name).join(', ')}`,
      blocked.map((item) => item.id),
    );
  },
};
