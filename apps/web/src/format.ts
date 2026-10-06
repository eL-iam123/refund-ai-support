import type { Decision, OverrideCode, RuleClass, RuleOutcome, Stage } from '@refund/shared';

/** Presentation-only helpers. Money stays integer cents until the moment it is shown. */

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const DECISION_LABEL: Record<Decision, string> = {
  approved: 'Approved',
  denied: 'Denied',
  escalated: 'Escalated',
  partial_refund: 'Partial refund',
  exchange: 'Exchange',
  store_credit: 'Store credit',
};

export const OUTCOME_LABEL: Record<RuleOutcome, string> = {
  approve: 'approve',
  deny: 'deny',
  escalate: 'escalate',
  pass: 'pass',
};

export const RULE_CLASS_LABEL: Record<RuleClass, string> = {
  eligibility: 'Eligibility',
  'approval-authority': 'Approval authority',
  risk: 'Risk signal',
  integrity: 'Integrity',
};

export const STAGE_LABEL: Record<Stage, string> = {
  intake: 'Intake',
  retrieve: 'Retrieve',
  fact_gates: 'Fact gates',
  ai_analysis: 'AI analysis',
  reason_rules: 'Reason rules',
  resolve: 'Resolve',
  respond: 'Respond',
};

export const OVERRIDE_LABEL: Record<OverrideCode, string> = {
  ai_proposal_rejected: 'AI proposal rejected',
  ai_proposed_approve_clamped_to_deny: 'Approve clamped to deny',
  ai_proposed_approve_clamped_to_escalate: 'Approve clamped to escalate',
  agent_requested_by_customer: 'Customer asked for a person',
  amount_clamped_to_order_value: 'Amount clamped to order value',
  amount_limited_to_remaining_balance: 'Capped to remaining balance',
  amount_limited_to_disputed_items: 'Limited to disputed items',
  amount_zeroed_on_deny: 'Amount zeroed on deny',
  amount_not_payable_until_reviewed: 'Escalated — not payable',
  risk_rule_deny_rejected: 'Risk-rule deny rejected',
  ungrounded_reason_escalated: 'Ungrounded reason escalated',
  untrusted_extraction_discarded: 'Untrusted claim discarded',
  low_confidence_claim_escalated: 'Low-confidence claim escalated',
  discretion_approve: 'Discretion approved',
  discretion_partial_refund: 'Discretion partial refund',
  discretion_exchange: 'Discretion offered exchange',
  discretion_store_credit: 'Discretion offered store credit',
};

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
