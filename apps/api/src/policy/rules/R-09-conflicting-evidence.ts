import { escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-09 - conflicting evidence. Risk class, so it escalates rather than denies:
 * the customer and the carrier record disagree, and only a human can say which
 * is right. Needs the model because the claim side is free text.
 */
export const R09ConflictingEvidence: PolicyRule = {
  id: 'R-09',
  title: 'Conflicting customer and fulfilment evidence',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §6.3',
  summary: 'A non-delivery claim that contradicts signed delivery records escalates.',
  evaluate(context) {
    const { order, extraction, grounding } = context;
    const claimsMissing = extraction?.reason === 'missing_item' && grounding?.grounded === true;
    if (!claimsMissing || order === null) {
      return pass(this, 'no delivery-conflict claim to check');
    }
    const signed = order.trackingStatus === 'delivered' && order.signedByCustomer;
    if (!signed) {
      return pass(this, 'non-delivery claim is not contradicted by delivery records');
    }
    const report = order.conditionAtDelivery ?? 'no condition reported';
    return escalate(
      this,
      `customer reports non-delivery but tracking shows delivered${order.conditionAtDelivery === null ? '' : ` and the recipient reported "${report}"`}`,
    );
  },
};
