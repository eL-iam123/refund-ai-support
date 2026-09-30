import type { ClaimExtraction } from '@refund/shared';
import {
  AiUnavailableError,
  type AgentReply,
  type AIAnalyzer,
  type AnalyzerInput,
  type AttemptObserver,
} from '../ai/analyzer.js';
import { LocalAnalyzer } from '../ai/localAnalyzer.js';

/**
 * The test doubles for a language model.
 *
 * `heuristic()` is not implemented here. It is the production `LocalAnalyzer`,
 * because the eighteen scenario fixtures are only worth having if they run
 * against the same code a machine with no API key runs - a second copy of the
 * pattern set in this file would drift from it, and the drift would show up as
 * a scenario that passes and a product that does not.
 *
 * The other three shapes are genuinely test-only, because they model ways a
 * provider behaves rather than a way of reading a message:
 *
 * - `fixed(...)` returns a hand-written claim, for tests about one rule.
 * - `ask(question, then)` returns a clarifying question on a cold turn and a
 *   claim on the following turn, for the interactive loop.
 * - `unavailable()` rejects, for the fail-soft path.
 */

export function FakeAnalyzer(behaviour: Behaviour = { kind: 'heuristic' }): AIAnalyzer {
  switch (behaviour.kind) {
    case 'heuristic':
      return LocalAnalyzer();
    case 'fixed':
      return fixedAnalyzer(behaviour);
    case 'ask':
      return askAnalyzer(behaviour);
    case 'unavailable':
      return unavailableAnalyzer(behaviour.message);
  }
}

export type Behaviour =
  | { readonly kind: 'heuristic' }
  | { readonly kind: 'fixed'; readonly extraction: Partial<ClaimExtraction> }
  | {
      readonly kind: 'ask';
      readonly question: string;
      /** The claim once the customer has answered the question. */
      readonly then: Partial<ClaimExtraction>;
    }
  | { readonly kind: 'unavailable'; readonly message: string };

const BASE_EXTRACTION: ClaimExtraction = {
  intent: 'refund',
  reason: 'other',
  condition: 'unknown',
  confidence: 0.5,
  orderRef: null,
  claimedAmountCents: null,
  items: [],
  evidenceQuotes: [],
  language: 'en',
  urgency: 'normal',
  policyOverrideAttempted: false,
};

function fixedAnalyzer(behaviour: { readonly extraction: Partial<ClaimExtraction> }): AIAnalyzer {
  const extraction = { ...BASE_EXTRACTION, ...behaviour.extraction };
  return {
    label: 'fake (test)',
    model: 'fake-fixed-v1',
    available: true,
    unavailableReason: null,
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AgentReply> {
      recordOk(observer, 'fake-fixed-v1');
      return Promise.resolve(claimReply(extraction, 'fake-fixed-v1'));
    },
  };
}

/**
 * The interactive double: one clarifying question, then a decided claim.
 *
 * `input.history` separates the turns - a cold start has no history, so the
 * first message gets the question, and any message that arrives after the
 * assistant has asked something is treated as the customer's answer, which
 * yields the claim. This is exactly the ask-then-decide arc the loop exists to
 * support, in a form deterministic enough to assert on.
 */
function askAnalyzer(behaviour: {
  readonly question: string;
  readonly then: Partial<ClaimExtraction>;
}): AIAnalyzer {
  const extraction = { ...BASE_EXTRACTION, ...behaviour.then };
  return {
    label: 'fake (test)',
    model: 'fake-ask-v1',
    available: true,
    unavailableReason: null,
    analyze(input: AnalyzerInput, observer: AttemptObserver): Promise<AgentReply> {
      recordOk(observer, 'fake-ask-v1');
      if (input.history.length === 0) {
        return Promise.resolve({ kind: 'question', question: behaviour.question, model: 'fake-ask-v1' });
      }
      return Promise.resolve(claimReply(extraction, 'fake-ask-v1'));
    },
  };
}

function claimReply(extraction: ClaimExtraction, model: string): AgentReply {
  return {
    kind: 'claim',
    extraction,
    proposal: {
      suggestedDecision: 'approved',
      suggestedAmountCents: extraction.claimedAmountCents ?? 0,
      confidence: extraction.confidence,
      reason: extraction.reason,
      model,
    },
    model,
  };
}

function unavailableAnalyzer(message: string): AIAnalyzer {
  return {
    label: 'fake (test)',
    model: 'fake-unavailable-v1',
    // Mirrors the real `UnavailableAnalyzer`: the reason is the message, and the
    // status endpoint that reports it is exercised by the same contract.
    available: false,
    unavailableReason: message,
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AgentReply> {
      recordOk(observer, 'fake-unavailable-v1');
      return Promise.reject(new AiUnavailableError(message));
    },
  };
}

function recordOk(observer: AttemptObserver, model: string): void {
  observer({
    model,
    attempt: 1,
    ok: true,
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    error: null,
  });
}
