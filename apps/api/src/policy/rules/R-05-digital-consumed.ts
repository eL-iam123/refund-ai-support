import { deny, pass, type PolicyRule } from '../types.js';

/** R-05 - consumed digital goods. Item-scoped, like R-02. */
export const R05DigitalConsumed: PolicyRule = {
  id: 'R-05',
  title: 'Digital goods already downloaded',
  ruleClass: 'eligibility',
  scope: 'item',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.2',
  summary: 'Digital licences that have already been downloaded are not refundable.',
  evaluate(context) {
    const blocked = context.order?.items.filter((item) => item.digital && item.downloaded) ?? [];
    if (blocked.length === 0) {
      return pass(this, 'no consumed digital items on this order');
    }
    return deny(
      this,
      `${blocked.length} downloaded digital item(s): ${blocked.map((i) => i.name).join(', ')}`,
      blocked.map((item) => item.id),
    );
  },
};
