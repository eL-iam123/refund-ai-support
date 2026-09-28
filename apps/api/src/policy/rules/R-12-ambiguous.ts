import { escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-12 - nothing usable to decide on. This is the safety valve: when the model
 * cannot point at words in the customer's message that support a reason, the
 * request goes to a person rather than being approved on a guess.
 */
export const R12AmbiguousRequest: PolicyRule = {
  id: 'R-12',
  title: 'No grounded reason in the request',
  ruleClass: 'approval-authority',
  scope: 'order',
  stage: 'reason_rules',
  policyRef: 'REFUND_POLICY.md §5.3',
  summary: 'A request with no verifiable reason escalates to a human.',
  evaluate(context) {
    const { extraction, grounding } = context;
    if (extraction === null) {
      return pass(this, 'no extraction available');
    }
    if (grounding !== null && !grounding.grounded) {
      return escalate(
        this,
        `no evidence in the customer's message supports "${extraction.reason}" (${grounding.rejectedQuotes.length} rejected quote(s))`,
      );
    }
    if (extraction.reason === 'other' || extraction.reason === 'none') {
      return escalate(this, `request states no refund reason (extracted as "${extraction.reason}")`);
    }
    return pass(this, `grounded reason "${extraction.reason}"`);
  },
};
