import { approve, hasGroundedFault, pass, type PolicyRule } from '../types.js';
import { formatCents } from '../../lib/money.js';

/**
 * R-04 - faulty goods. The only rule that can approve a request on the strength
 * of what the customer said, which is exactly why it demands a grounded quote
 * rather than a confident reason code.
 */
export const R04FaultyGoods: PolicyRule = {
  id: 'R-04',
  title: 'Damaged or incorrect goods',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §5.1',
  summary: 'Verified damage or an incorrect item qualifies for automatic approval.',
  evaluate(context) {
    if (!hasGroundedFault(context)) {
      return pass(this, 'no grounded damage or incorrect-item claim');
    }
    if (context.eligibleAmountCents === 0) {
      return pass(this, 'no eligible items remain to refund');
    }
    const { extraction, grounding } = context;
    const confidence = extraction?.confidence ?? 0;
    const quotes = grounding?.verifiedQuotes.length ?? 0;
    return approve(
      this,
      `grounded "${extraction?.reason}" claim (confidence ${confidence.toFixed(2)}, ${quotes} verified quote(s)) covering ${formatCents(context.eligibleAmountCents)} of eligible items`,
    );
  },
};
