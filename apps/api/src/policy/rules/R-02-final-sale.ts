import { deny, pass, type PolicyRule } from '../types.js';

/**
 * R-02 - final sale. Item-scoped: blocks only the marked items, so a mixed
 * basket continues with whatever remains eligible.
 */
export const R02FinalSale: PolicyRule = {
  id: 'R-02',
  title: 'Final sale items',
  ruleClass: 'eligibility',
  scope: 'item',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.1',
  summary: 'Items marked final sale are not eligible for refund.',
  evaluate(context) {
    const blocked = context.order?.items.filter((item) => item.finalSale) ?? [];
    if (blocked.length === 0) {
      return pass(this, 'no final-sale items on this order');
    }
    return deny(
      this,
      `${blocked.length} item(s) marked final sale: ${blocked.map((i) => i.name).join(', ')}`,
      blocked.map((item) => item.id),
    );
  },
};
