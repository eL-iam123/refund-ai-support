import {
  RISK_NEW_ACCOUNT_DAYS,
  RISK_PRIOR_REFUNDS,
  RISK_RECENT_REQUESTS,
  RISK_SIGNAL_THRESHOLD,
} from '../constants.js';
import { escalate, pass, type PolicyRule } from '../types.js';

/**
 * R-08 - abuse signals. Escalate, never deny: a burst of refunds can be a
 * genuine run of bad luck, and refusing on a signal alone punishes the
 * customer for something we have not proven. Two independent signals required.
 */
export const R08AbuseSignals: PolicyRule = {
  id: 'R-08',
  title: 'Refund abuse signals',
  ruleClass: 'risk',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §6.2',
  summary: 'Independent risk signals escalate to human review; they never deny.',
  evaluate(context) {
    const customer = context.customer;
    if (customer === null) {
      return pass(this, 'no customer resolved');
    }

    const signals: string[] = [];
    if (customer.accountAgeDays < RISK_NEW_ACCOUNT_DAYS) {
      signals.push(`account only ${customer.accountAgeDays} days old`);
    }
    if (customer.priorRefundCount >= RISK_PRIOR_REFUNDS) {
      signals.push(`${customer.priorRefundCount} prior refunds on record`);
    }
    if (customer.refundRequestsLast30Days >= RISK_RECENT_REQUESTS) {
      signals.push(`${customer.refundRequestsLast30Days} refund requests in the last 30 days`);
    }

    if (signals.length < RISK_SIGNAL_THRESHOLD) {
      return pass(this, signals.length === 0 ? 'no risk signals' : `single signal: ${signals[0]}`);
    }
    return escalate(this, `${signals.length} risk signals: ${signals.join('; ')}`);
  },
};
