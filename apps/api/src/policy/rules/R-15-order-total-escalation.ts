import { escalate, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-15 - order total above the manual-review ceiling.
 *
 * A blunt, non-negotiable rule: any order whose total exceeds the configured
 * ceiling must not be decided automatically, regardless of how many items are
 * in the basket or what each one costs. The check fires on the order's own
 * totalCents, before the customer has selected items and before the model is
 * called.
 *
 * The ceiling is supplied via PolicyContext.escalationCeilingCents so the rule
 * stays a pure function of its inputs and the policy path can be tested with
 * no process env at all.
 */
export const R15OrderTotalEscalation: PolicyRule = {
  id: 'R-15',
  title: 'Order total exceeds manual-review ceiling',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §6.5',
  summary: 'This order requires a person to review it before anything is approved.',
  evaluate(context) {
    const total = context.order?.totalCents ?? 0;
    if (total > context.escalationCeilingCents) {
      return escalate(this, `order total ${formatCents(total)} exceeds the manual-review ceiling`);
    }
    return pass(this, `order total ${formatCents(total)} is within the manual-review ceiling`);
  },
};
