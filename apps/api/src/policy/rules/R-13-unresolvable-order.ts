import { escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-13 - unresolvable order reference. Risk class: escalate, never deny.
 * Failing to match an order is a failure of our lookup, not proof that the
 * customer is wrong, and denying here could refuse a genuine claim.
 */
export const R13UnresolvableOrder: PolicyRule = {
  id: 'R-13',
  title: 'Order reference cannot be resolved',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §6.4',
  summary: 'An unmatched order reference escalates rather than denies.',
  evaluate(context) {
    if (context.order !== null) {
      return pass(this, 'order resolved');
    }
    return escalate(this, 'no order matched the supplied or inferred reference');
  },
};
