import { approve, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-11 - duplicate charge. Corroborated by data, not by belief: there must be
 * a same-day, same-value sibling order. The customer saying "you charged me
 * twice" proves nothing on its own.
 */
export const R11DuplicateCharge: PolicyRule = {
  id: 'R-11',
  title: 'Duplicate charge',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §5.2',
  summary: 'A same-day duplicate of an identical order is refunded without fuss.',
  evaluate(context) {
    const claimsDuplicate = context.extraction?.reason === 'duplicate_charge';
    if (!claimsDuplicate) {
      return pass(this, 'no duplicate-charge claim');
    }
    if (context.duplicateSibling === null) {
      return pass(this, 'claimed duplicate charge could not be corroborated by an order pair');
    }
    if (context.eligibleAmountCents === 0) {
      return pass(this, 'no eligible amount to refund');
    }
    return approve(
      this,
      `duplicate of ${context.duplicateSibling.id} (same day, ${formatCents(context.order?.totalCents ?? 0)}) corroborated in order data`,
    );
  },
};
