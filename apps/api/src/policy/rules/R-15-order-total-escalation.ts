import { escalate, pass, disputedClaimCents, type PolicyRule } from '../types.js';
import { ESCALATION_CEILING_CENTS } from '../constants.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-15 - order total above the manual-review ceiling.
 *
 * A blunt, non-negotiable rule: a claim whose disputed amount exceeds the
 * configured ceiling must not be decided automatically. The disputed amount is
 * the sum of the lines the customer pointed at when they named lines, otherwise
 * the order's own totalCents - so a $12 mug on a large order is decided like
 * any small claim, while a claim covering the whole order keeps the ceiling
 * check on the order total. Both figures are computable from the order facts
 * alone, before the model is called.
 *
 * The ceiling is supplied via PolicyContext.escalationCeilingCents so the rule
 * stays a pure function of its inputs and the policy path can be tested with
 * no process env at all.
 */
export const R15OrderTotalEscalation: PolicyRule = {
  id: 'R-15',
  title: 'Amount at risk exceeds manual-review ceiling',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §6.5',
  summary:
    'A claim or order above the manual-review ceiling requires a person to review it before anything is approved.',
  evaluate(context) {
    const disputed = disputedClaimCents(context);
    const amount = disputed ?? (context.order?.totalCents ?? 0);
    const ceiling = context.escalationCeilingCents ?? ESCALATION_CEILING_CENTS;
    const basis =
      disputed !== null
        ? `claimed items total of ${formatCents(amount)}`
        : `order total of ${formatCents(amount)}`;
    if (amount > ceiling) {
      return escalate(this, `${basis} exceeds the manual-review ceiling`);
    }
    return pass(this, `${basis} is within the manual-review ceiling`);
  },
};
