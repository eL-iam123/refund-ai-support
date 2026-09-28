import type { AiProposal, ClaimExtraction } from '@refund/shared';

/**
 * The one seam between the policy engine and a language model.
 *
 * Everything above this file is provider-agnostic and deterministic. Everything
 * below it is "ask a model to read a message". The interface is deliberately
 * narrow - one method, one job - because the security argument of this system
 * is that the model's entire influence is a single `ClaimExtraction` that the
 * resolver is free to overrule.
 *
 * The production implementation is a real HTTP client. The test implementation
 * is a fake in `src/test/`. There is no "offline mode" and no simulated model
 * in the product, because a fake that ships to users is a second, untested
 * decision path.
 */

export interface AnalyzerItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/**
 * The order, flattened for the model.
 *
 * A plain summary rather than the database record: the AI layer should not know
 * what a `OrderRecord` is, so adding a column to the schema cannot silently
 * widen what gets sent to a provider.
 */
export interface AnalyzerOrder {
  readonly id: string;
  readonly totalCents: number;
  readonly status: string;
  readonly paymentState: string;
  readonly ageDays: number;
  readonly items: readonly AnalyzerItem[];
}

export interface AnalyzerInput {
  readonly message: string;
  /** Null when no order could be resolved for the customer. */
  readonly order: AnalyzerOrder | null;
}

export interface AnalyzerResult {
  /** The model's reading of the message. A claim, never a decision. */
  readonly extraction: ClaimExtraction;
  /** What the model would like to happen. Recorded, compared, and overridable. */
  readonly proposal: AiProposal;
  readonly model: string;
}

export interface ProviderAttempt {
  readonly model: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly error: string | null;
}

/**
 * Called once per network attempt, including failures and models that were
 * tried after a failure. This is the audit trail, so it must not be filtered.
 */
export type AttemptObserver = (attempt: ProviderAttempt) => void;

export interface AIAnalyzer {
  /** Human-readable provider name, shown in the admin drawer. */
  readonly label: string;
  /** The model that will be tried first. */
  readonly model: string;
  /**
   * Reads the customer's message and returns a structured claim.
   *
   * Rejects with `AiUnavailableError` when no configured model produced
   * schema-valid output. Callers treat that as "no claim", which can only
   * escalate - the decision is computed from order facts either way.
   */
  analyze(input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult>;
}

/** Every configured model failed, or none of them answered with valid JSON. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}
