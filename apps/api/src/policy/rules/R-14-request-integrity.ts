import { deny, escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-14 - integrity of the request channel.
 *
 * Detected during intake but deliberately NOT terminal here: the request is
 * allowed to reach the model so that the resolver can be shown clamping a real
 * proposal, and the untrusted extraction is discarded. See
 * docs/adr/0002-injection-scope-and-limits.md for why that is safe.
 *
 * `INJECTION_ACTION` chooses between refusing the request and handing it to a
 * human. Denying is the default, and the one that survives a scanner miss being
 * treated as an attack. `escalate` exists because the scanner is high-precision
 * rather than high-recall: a false denial costs a real customer their refund,
 * which is a worse failure than a queued review. Neither branch can approve
 * anything, because escalate sits below approve in precedence and this rule
 * never returns approve.
 */
export const R14RequestIntegrity: PolicyRule = {
  id: 'R-14',
  title: 'Policy override attempt',
  ruleClass: 'integrity',
  scope: 'order',
  stage: 'intake',
  policyRef: 'REFUND_POLICY.md §7.1',
  summary: 'Attempts to override policy, force a decision, move an amount, or claim authority are denied.',
  evaluate(context) {
    if (!context.injection.detected) {
      return pass(this, 'no policy-override signal');
    }
    const categories = [...new Set(context.injection.signals.map((signal) => signal.category))];
    const evidence = `${context.injection.signals.length} policy-override signal(s): ${categories.join(', ')}`;
    if (context.injectionAction === 'escalate') {
      return escalate(this, `${evidence}; routed to human review by INJECTION_ACTION=escalate`);
    }
    return deny(this, evidence);
  },
};
