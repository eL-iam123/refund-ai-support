import { setTimeout as sleep } from 'node:timers/promises';
import { AiUnavailableError } from './analyzer.js';

/**
 * The candidate ladder, and the breaker that stops it walking into a wall.
 *
 * Both live here, in one file, because the thing they have in common is that they
 * exist for the same failure. Four loops across the two adapters were walking the
 * same ladder - intake and chat, OpenAI-shaped and Anthropic-shaped - and a fifth
 * copy of a breaker inside each of them is exactly the way a provider outage turns
 * into four subtly different outages.
 *
 * What already existed, and what did not:
 *
 *  - **Existed.** Candidates are tried in order, each is retried with a fixed
 *    backoff, transport failures are retried and structural ones are not, and an
 *    unknown error type is treated as a bug rather than as a flaky provider. A
 *    non-retryable failure moves to the next candidate immediately.
 *  - **Did not.** Any of it survived a request. Every new message re-probed a model
 *    that had already refused to answer, and paid for the discovery - a round
 *    trip per attempt, plus the backoff sleeps, for every customer in the queue.
 *    During a real outage that is the difference between failing one request and
 *    failing all of them slowly.
 *
 * So the breaker holds what the ladder learned, per model, for as long as the
 * process lives.
 */

/** Fixed backoff between attempts of the same model, in milliseconds. */
const BACKOFF_MS: readonly number[] = [250, 750, 1_500];

export interface BreakerConfig {
  /** Consecutive failures before a model stops being tried. */
  readonly failureThreshold: number;
  /** How long a model stays untried before one probe is allowed through. */
  readonly resetAfterMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

interface ModelRecord {
  consecutiveFailures: number;
  /** When the model was last tripped, or null while it is closed. */
  openedAt: number | null;
  /** Whether a half-open probe is already in flight for this model. */
  probeInFlight: boolean;
}

function closedRecord(): ModelRecord {
  return { consecutiveFailures: 0, openedAt: null, probeInFlight: false };
}

/**
 * Per-model circuit breaker.
 *
 * Three states, and the transitions are the whole design:
 *
 *  - **closed** - try it. Success clears the count; failure counts.
 *  - **open** - do not try it, and say so. Tripped after `failureThreshold`
 *    consecutive failures, and it stays open for `resetAfterMs`. Note that only
 *    *consecutive* failures count: a model that succeeds resets, so a provider
 *    flapping between good and bad is never treated as down.
 *  - **half-open** - try it once, and let the answer decide. Exactly one probe is
 *    admitted, because an open circuit exists to stop a thundering herd, and a herd
 *    that is still allowed through is just a slower herd.
 *
 * A non-retryable failure trips the breaker too. "This model cannot answer in the
 * shape we ask for" is not a reason to keep asking it - the same request will fail
 * identically - so it is a failure of the model rather than of the moment.
 *
 * One instance per analyzer, so a test that builds its own analyzer cannot inherit
 * another test's view of a provider. A single process-wide registry would have been
 * marginally more accurate about a shared dependency and considerably worse to
 * reason about.
 */
export class ModelCircuitBreaker {
  private readonly records = new Map<string, ModelRecord>();

  constructor(
    private readonly config: BreakerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this model may be attempted right now. */
  admit(model: string): boolean {
    const record = this.records.get(model);
    if (record === undefined || record.consecutiveFailures < this.config.failureThreshold) {
      return true;
    }
    if (this.now() - (record.openedAt ?? 0) < this.config.resetAfterMs) {
      return false;
    }
    if (record.probeInFlight) {
      return false;
    }
    record.probeInFlight = true;
    return true;
  }

  recordSuccess(model: string): void {
    this.records.delete(model);
  }

  /**
   * Record a failed attempt.
   *
   * `retryable` is the whole argument here. A transport error, a 429 or a 5xx is
   * evidence the model is *unavailable*, and that is what an open circuit means. A
   * schema mismatch or a reply that ran out of tokens is evidence about *this
   * request*, and counting it makes a perfectly healthy model look dead: the
   * storefront would report the assistant unavailable, the escalation notice would
   * change, and nothing was actually wrong with the provider. Those failures still
   * fail the request and still move to the next candidate; they just do not open the
   * circuit.
   */
  recordFailure(model: string, retryable: boolean): void {
    const record = this.records.get(model) ?? closedRecord();
    record.probeInFlight = false;
    if (!retryable) {
      this.records.set(model, record);
      return;
    }
    record.consecutiveFailures += 1;
    if (record.consecutiveFailures >= this.config.failureThreshold) {
      // Re-arm the clock on every trip, so a model that keeps failing stays open
      // rather than being re-probed on every cooldown interval.
      record.openedAt = this.now();
    }
    this.records.set(model, record);
  }

  /** The state of each candidate, for the health endpoint and for error text. */
  snapshot(candidates: readonly string[]): readonly { model: string; state: BreakerState; consecutiveFailures: number }[] {
    return candidates.map((model) => {
      const record = this.records.get(model);
      if (record === undefined || record.consecutiveFailures < this.config.failureThreshold) {
        return { model, state: 'closed', consecutiveFailures: record?.consecutiveFailures ?? 0 };
      }
      const cooling = this.now() - (record.openedAt ?? 0) < this.config.resetAfterMs;
      return {
        model,
        state: cooling ? 'open' : 'half_open',
        consecutiveFailures: record.consecutiveFailures,
      };
    });
  }

  /** True when nothing can be tried: every candidate is open. */
  allOpen(candidates: readonly string[]): boolean {
    return candidates.length > 0 && this.snapshot(candidates).every((entry) => entry.state === 'open');
  }

  /** Why the analyzer reports itself unavailable, or null when it is fine. */
  reason(candidates: readonly string[]): string | null {
    if (!this.allOpen(candidates)) {
      return null;
    }
    const states = this.snapshot(candidates)
      .map((entry) => `${entry.model} (${entry.state})`)
      .join(', ');
    return `every configured model is currently tripping its circuit breaker: ${states}`;
  }
}

/** One attempt's outcome, as the ladder sees it. */
export type AttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export type LadderResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failures: readonly string[];
      readonly skipped: readonly string[];
      /** One sentence naming what stopped it, for the audit and the log. */
      readonly reason: string;
    };

export interface LadderDeps<T> {
  readonly candidates: readonly string[];
  readonly maxAttempts: number;
  readonly breaker: ModelCircuitBreaker;
  readonly budget: AbortSignal;
  /** What the ladder is doing, for the failure text. */
  readonly purpose: string;
  readonly attempt: (model: string, attempt: number) => Promise<AttemptOutcome<T>>;
}

/**
 * Every candidate, `maxAttempts` times each, skipping whatever the breaker has open.
 *
 * Bounds are visible in the two loops and both are named, per Rule 2: candidates is
 * a configured list and `maxAttempts` comes from the environment with a ceiling.
 * Skipped models are reported rather than attempted - and deliberately *not* sent to
 * the observer, because an attempt that never happened is not a provider call and
 * `llm_calls` is an audit trail rather than a log.
 */
export async function runCandidates<T>(deps: LadderDeps<T>): Promise<LadderResult<T>> {
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const model of deps.candidates) {
    if (!deps.breaker.admit(model)) {
      skipped.push(model);
      continue;
    }
    if (deps.budget.aborted) {
      break;
    }

    for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
      const outcome = await deps.attempt(model, attempt);
      if (outcome.ok) {
        deps.breaker.recordSuccess(model);
        return { ok: true, value: outcome.value };
      }
      failures.push(`${model}#${attempt} ${outcome.error}`);
      deps.breaker.recordFailure(model, outcome.retryable);

      const canRetry = attempt < deps.maxAttempts && outcome.retryable && !deps.budget.aborted;
      if (!canRetry) {
        break;
      }
      await backoff(attempt, deps.budget);
    }
  }

  return { ok: false, failures, skipped, reason: failureReason(deps, failures, skipped) };
}

/**
 * Why the ladder gave up, in one sentence.
 *
 * The skipped models are named explicitly because they are the diagnosis: if every
 * candidate was already tripped, the answer is "we knew", not "we tried and failed",
 * and an operator reading the audit needs to be able to tell those apart.
 */
function failureReason<T>(deps: LadderDeps<T>, failures: readonly string[], skipped: readonly string[]): string {
  const known = skipped.length > 0 ? `${skipped.length} model(s) already tripping: ${skipped.join(', ')}` : 'none skipped';
  const detail = cap(failures.join(' | '), 400);
  if (deps.budget.aborted) {
    return `${deps.purpose} time budget exhausted after ${failures.length} attempt(s) (${known}); ${detail}`;
  }
  if (failures.length === 0) {
    return `${deps.purpose} had no model available to try (${known})`;
  }
  return `all ${deps.candidates.length} model(s) failed after ${failures.length} attempt(s), ${known}: ${detail}`;
}

/** The message a caller throws with. One place, so every adapter says it the same way. */
export function unavailableFrom<T>(result: Extract<LadderResult<T>, { ok: false }>): AiUnavailableError {
  return new AiUnavailableError(result.reason);
}

/**
 * Fixed backoff between attempts of the same model.
 *
 * Bounded and short: the breaker is what protects the queue during a long outage,
 * and this only has to ride out a blip. Sleeping on an aborted budget throws rather
 * than returning, so a customer who has already waited their budget stops waiting.
 */
export async function backoff(attempt: number, budget: AbortSignal): Promise<void> {
  const last = BACKOFF_MS.length - 1;
  const wait = BACKOFF_MS[Math.min(attempt - 1, last)] ?? BACKOFF_MS[last] ?? 1_000;
  try {
    await sleep(wait, undefined, { signal: budget });
  } catch (error: unknown) {
    if (budget.aborted) {
      throw new AiUnavailableError('analysis time budget exhausted while backing off');
    }
    throw error;
  }
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}