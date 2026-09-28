import type { RuleScope, Stage } from '@refund/shared';
import type { PolicyRule } from '../types.js';
import { R01Window } from './R-01-window.js';
import { R01bStandardWindow } from './R-01b-standard-window.js';
import { R02FinalSale } from './R-02-final-sale.js';
import { R03AmountAuthority } from './R-03-amount-authority.js';
import { R03bThresholdRecheck } from './R-03b-threshold-recheck.js';
import { R04FaultyGoods } from './R-04-faulty-goods.js';
import { R05DigitalConsumed } from './R-05-digital-consumed.js';
import { R06PaymentState } from './R-06-payment-state.js';
import { R06bRefundableBalance } from './R-06b-refundable-balance.js';
import { R07ChargebackOpen } from './R-07-chargeback.js';
import { R08AbuseSignals } from './R-08-abuse-signals.js';
import { R09ConflictingEvidence } from './R-09-conflicting-evidence.js';
import { R10Subscription } from './R-10-subscription.js';
import { R11DuplicateCharge } from './R-11-duplicate-charge.js';
import { R12AmbiguousRequest } from './R-12-ambiguous.js';
import { R13UnresolvableOrder } from './R-13-unresolvable-order.js';
import { R14RequestIntegrity } from './R-14-request-integrity.js';

/**
 * The policy, as one literal ordered list.
 *
 * This is deliberately a static array rather than a registry that resolves
 * handlers at runtime (coding standard 9: avoid indirection and dynamic
 * dispatch). The entire rulebook is greppable, orderable and diffable on a
 * single screen, and the evaluation order below is the audit order.
 *
 * Item-affecting rules come first within the gate stage because the eligible
 * amount that R-03 and R-03b depend on is only known once they have run.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  // Intake - recorded before retrieval, resolved last.
  R14RequestIntegrity,

  // Fact gates - decided from order data alone, no model required.
  R02FinalSale,
  R05DigitalConsumed,
  R01Window,
  R06PaymentState,
  R06bRefundableBalance,
  R10Subscription,
  R07ChargebackOpen,
  R08AbuseSignals,
  R13UnresolvableOrder,
  R03AmountAuthority,
  R03bThresholdRecheck,

  // Reason rules - require the extracted claim.
  R01bStandardWindow,
  R04FaultyGoods,
  R09ConflictingEvidence,
  R11DuplicateCharge,
  R12AmbiguousRequest,
];

export function rulesForStage(stage: Stage): PolicyRule[] {
  return POLICY_RULES.filter((rule) => rule.stage === stage);
}

export function rulesForScope(scope: RuleScope): PolicyRule[] {
  return POLICY_RULES.filter((rule) => rule.scope === scope);
}

export function findRule(id: string): PolicyRule | null {
  return POLICY_RULES.find((rule) => rule.id === id) ?? null;
}

export { ALLOWED_OUTCOMES } from '@refund/shared';
