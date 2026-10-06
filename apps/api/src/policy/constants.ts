/**
 * Policy thresholds. Each constant mirrors a clause of REFUND_POLICY.md; the
 * doc and these numbers must change together. Values are integer cents.
 */

/** §3.1 Standard refund window, counted from delivery. */
export const STANDARD_WINDOW_DAYS = 30;

/** §3.2 Absolute outer limit. Nothing is refundable past this, whatever the reason. */
export const EXTENDED_WINDOW_DAYS = 45;

/** §4.1 Refunds above this amount require human review. */
export const HUMAN_REVIEW_THRESHOLD_CENTS = 50_000;

/** §6.5 Order total above this ceiling requires human review before any item is selected. */
export const ESCALATION_CEILING_CENTS = 50_000;

/** §2.3 Payment state that means the order has already been refunded. */
export const FULLY_REFUNDED = 'refunded';

/** §6.2 Risk-signal thresholds for R-08. A single signal never escalates. */
export const RISK_NEW_ACCOUNT_DAYS = 7;
export const RISK_PRIOR_REFUNDS = 3;
export const RISK_RECENT_REQUESTS = 3;

/** §6.2 An order needs at least this many independent risk signals to escalate. */
export const RISK_SIGNAL_THRESHOLD = 2;

/** §8.1 Grounding: quotes shorter than this cannot evidence a claim. */
export const MIN_EVIDENCE_QUOTE_LENGTH = 4;

/** §8.2 Grounding: a claim needs at least this many verified quotes. */
export const MIN_GROUNDED_QUOTES = 1;
