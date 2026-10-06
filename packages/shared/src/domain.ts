/**
 * Core domain vocabulary shared by the API, the web client and the test suite.
 *
 * One important convention lives here: the LLM never authors a `Decision`.
 * It produces a `ClaimExtraction` (stage 4) which is *evidence*, and the
 * resolver (stage 6) is the only writer of a `Decision`. See REFUND_POLICY.md
 * and docs/adr/0001-resolver-is-sole-authority.md.
 */

// --- Decisions --------------------------------------------------------------

/**
 * What can happen to a refund request.
 *
 * `approved`, `denied` and `escalated` are the three outcomes the base policy
 * produces. The three alternatives exist so a resolution that is *not* a full
 * refund still closes the request the way a human assistant would: `partial_refund`
 * authorises a reduced amount (and reserves it), while `exchange` and
 * `store_credit` resolve the request without moving refund money. They are only
 * ever produced by the discretion layer, never by a rule, and never by the model.
 */
export const DECISIONS = [
  'approved',
  'denied',
  'escalated',
  'partial_refund',
  'exchange',
  'store_credit',
] as const;
export type Decision = (typeof DECISIONS)[number];

/** Decisions that authorise money to leave the till. */
export const MONEY_DECISIONS: ReadonlySet<Decision> = new Set<Decision>(['approved', 'partial_refund']);

// --- Handoffs ---------------------------------------------------------------

/**
 * The `agent_id` of a live takeover no person has claimed yet.
 *
 * An escalation raises the takeover with this id and a staff member claiming it
 * replaces it with their own. Shared so the client can recognise "waiting for a
 * person" from the id alone, which keeps a new client correct even when it is
 * talking to a server older than the `unattended` flag.
 */
export const AWAITING_AGENT_ID = 'awaiting-agent';

// --- Rules ------------------------------------------------------------------

/**
 * Rule classes encode *what kind of authority* a rule has.
 *
 * `risk` is the important one: risk signals (abuse, chargeback, conflicting
 * evidence, unresolvable references) may escalate to a human but may NEVER
 * deny. Denying on a risk signal is an unjust refusal of a valid claim, so the
 * restriction is data (see ALLOWED_OUTCOMES) rather than convention.
 */
export const RULE_CLASSES = ['eligibility', 'approval-authority', 'risk', 'integrity'] as const;
export type RuleClass = (typeof RULE_CLASSES)[number];

/** Precedence. DENY > ESCALATE > APPROVE. REFUND_POLICY.md §9. */
export const PRECEDENCE = { deny: 3, escalate: 2, approve: 1, pass: 0 } as const satisfies Record<
  RuleOutcome,
  number
>;

export const RULE_OUTCOMES = ['deny', 'escalate', 'approve', 'pass'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

/** Which outcomes each rule class is permitted to produce. */
export const ALLOWED_OUTCOMES = {
  eligibility: ['deny', 'pass', 'approve'],
  'approval-authority': ['escalate', 'pass'],
  risk: ['escalate', 'pass'],
  // Integrity may escalate, which grants it *less* authority than denying, never
  // more. Denying is the default; the escape hatch exists so an operator can route
  // a flagged-but-possibly-honest message to a human instead of refusing it.
  integrity: ['deny', 'escalate', 'pass'],
} as const satisfies Record<RuleClass, readonly RuleOutcome[]>;

/** `item` rules adjust the eligible set; `order` rules can terminate a request. */
export const RULE_SCOPES = ['order', 'item'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export const RULE_IDS = [
  'R-01',
  'R-01b',
  'R-02',
  'R-03',
  'R-03b',
  'R-04',
  'R-05',
  'R-06',
  'R-06b',
  'R-07',
  'R-08',
  'R-09',
  'R-10',
  'R-11',
  'R-12',
  'R-13',
  'R-14',
  'R-15',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

// --- Pipeline ---------------------------------------------------------------

export const STAGES = [
  'intake',
  'retrieve',
  'fact_gates',
  'ai_analysis',
  'reason_rules',
  'resolve',
  'respond',
] as const;
export type Stage = (typeof STAGES)[number];

/** Per-stage timing, shown in the admin drawer so a slow request is explainable. */
export interface StageTiming {
  readonly stage: Stage;
  readonly durationMs: number;
  readonly detail: string;
}

// --- Customer claim vocabulary ---------------------------------------------

export const REASON_CODES = [
  'damaged',
  'wrong_item',
  'not_as_described',
  'late_delivery',
  'missing_item',
  'duplicate_charge',
  'changed_mind',
  'other',
  'none',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Reasons that R-04 treats as qualifying for automatic approval. */
export const FAULTY_REASONS: readonly ReasonCode[] = ['damaged', 'wrong_item', 'not_as_described'];

export const ITEM_CONDITIONS = [
  'damaged',
  'possibly_damaged',
  'incorrect',
  'missing',
  'unopened',
  'unknown',
] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const INTENTS = ['refund', 'exchange', 'other'] as const;
export type Intent = (typeof INTENTS)[number];

// --- Evaluations and decisions ---------------------------------------------

export interface RuleEvaluation {
  readonly ruleId: RuleId;
  readonly ruleClass: RuleClass;
  readonly scope: RuleScope;
  readonly outcome: RuleOutcome;
  /** Human-readable justification, shown verbatim in the admin drawer. */
  readonly evidence: string;
  /** Section of REFUND_POLICY.md this rule implements. */
  readonly policyRef: string;
  /** Present for item-scoped evaluations. */
  readonly itemIds: readonly string[];
}

/**
 * Where a return stands.
 *
 * Shared because the staff console renders these and offers the moves each one
 * allows. A client keeping its own copy would eventually offer a move the server
 * refuses, and the failure would look like the parcel being in two states at once.
 */
export const RETURN_STATUSES = [
  'return_requested',
  'return_label_generated',
  'return_shipped',
  'return_received',
  'return_processed',
  'return_denied',
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const CARRIERS = ['usps', 'ups', 'fedex'] as const;

export type Carrier = (typeof CARRIERS)[number];

export const OVERRIDE_CODES = [
  'ai_proposal_rejected',
  'ai_proposed_approve_clamped_to_deny',
  'ai_proposed_approve_clamped_to_escalate',
  'amount_clamped_to_order_value',
  'amount_limited_to_disputed_items',
  'amount_limited_to_remaining_balance',
  'amount_zeroed_on_deny',
  'amount_not_payable_until_reviewed',
  'risk_rule_deny_rejected',
  'ungrounded_reason_escalated',
  'untrusted_extraction_discarded',
  'low_confidence_claim_escalated',
  'agent_requested_by_customer',
  'discretion_approve',
  'discretion_partial_refund',
  'discretion_exchange',
  'discretion_store_credit',
] as const;
export type OverrideCode = (typeof OVERRIDE_CODES)[number];

export interface OverrideRecord {
  readonly code: OverrideCode;
  readonly detail: string;
  /** What the model actually proposed, preserved even when rejected. */
  readonly aiProposal: AiProposal | null;
}

/** What the model suggested. Data, never an outcome. */
export interface AiProposal {
  readonly suggestedDecision: Decision;
  readonly suggestedAmountCents: number;
  readonly confidence: number;
  readonly reason: ReasonCode;
  readonly model: string;
}

export interface BlockedItem {
  readonly itemId: string;
  readonly name: string;
  readonly priceCents: number;
  readonly ruleId: RuleId;
  readonly reason: string;
}

/** The single source of truth for what happens to a request. */
export interface RefundDecision {
  readonly decision: Decision;
  /**
   * The amount authorised for payment: non-zero only when `decision` is
   * `approved`.
   *
   * Not "the amount under consideration". A field called `refundAmountCents`
   * that carried a figure on a `denied` or `escalated` decision is a trap for
   * whatever consumes this next - a payout job, a report, an export - and the
   * whole point of the resolver is that the amount it returns is what happens.
   * A denial pays nothing; an escalation has not authorised anything and the
   * decision is still a human's to make. The figure a reviewer needs is on
   * `eligibleAmountCents`, and on the trace, where it cannot be mistaken for a
   * payment.
   */
  readonly refundAmountCents: number;
  /**
   * Order-derived value of the eligible items, independent of the decision.
   * Retained separately because a denial zeroes the refund while leaving this
   * intact - which is the figure a human needs in order to override that denial,
   * and the one that must never be payable.
   */
  readonly eligibleAmountCents: number;
  readonly currency: 'USD';
  readonly summary: string;
  readonly policyRef: string;
  readonly trace: readonly RuleEvaluation[];
  readonly overrides: readonly OverrideRecord[];
  readonly eligibleItemIds: readonly string[];
  readonly blockedItems: readonly BlockedItem[];
  /**
   * Money earlier claims have already committed to this order: refunded, or
   * approved and waiting for a person to check it. Zero when none.
   *
   * Here so the reply can mention it. Without it, a customer whose order is
   * fully reserved reads "we are not able to refund this order" while a refund
   * for that same order is pending - both statements true, together they read as
   * a refusal, and the customer concludes the pending refund was cancelled.
   * Computed from the ledger, never from the model.
   */
  readonly outstandingAmountCents: number;
  readonly outstandingState: 'none' | 'pending' | 'settled' | 'mixed';
}

// --- LLM output -------------------------------------------------------------

/**
 * Structured claim extraction. Every field is validated against a JSON Schema
 * before it enters the pipeline, and `evidenceQuotes` is independently
 * grounding-checked against the customer's own words.
 */
export interface ClaimExtraction {
  readonly intent: Intent;
  readonly reason: ReasonCode;
  readonly condition: ItemCondition;
  readonly confidence: number;
  readonly orderRef: string | null;
  readonly claimedAmountCents: number | null;
  readonly items: readonly string[];
  readonly evidenceQuotes: readonly string[];
  readonly language: string;
  readonly urgency: 'low' | 'normal' | 'high';
  /** The model's opinion on injection. Recorded for audit, never trusted. */
  readonly policyOverrideAttempted: boolean;
}

export interface GroundingResult {
  readonly grounded: boolean;
  readonly verifiedQuotes: readonly string[];
  readonly rejectedQuotes: readonly string[];
}

// --- Audit ------------------------------------------------------------------

export const INJECTION_CATEGORIES = [
  'policy_override',
  'decision_manipulation',
  'amount_manipulation',
  'role_impersonation',
] as const;
export type InjectionCategory = (typeof INJECTION_CATEGORIES)[number];

/** Configured response to a detected override attempt. See REFUND_POLICY.md §7.1. */
export const INJECTION_ACTIONS = ['deny', 'escalate'] as const;
export type InjectionAction = (typeof INJECTION_ACTIONS)[number];

export interface InjectionSignal {
  readonly category: InjectionCategory;
  readonly pattern: string;
  readonly matchedText: string;
}

export interface InjectionScan {
  readonly detected: boolean;
  readonly signals: readonly InjectionSignal[];
  /** Non-decision-affecting oddities, recorded only. */
  readonly obfuscationNoted: boolean;
}
