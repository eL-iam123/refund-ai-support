import type { ClaimExtraction } from '@refund/shared';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type AnalyzerInput,
  type AnalyzerResult,
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
 * The other two shapes are genuinely test-only, because they model ways a
 * provider misbehaves rather than a way of reading a message:
 *
 * - `fixed(...)` returns a hand-written claim, for tests about one rule.
 * - `unavailable()` rejects, for the fail-soft path.
 */

export function FakeAnalyzer(behaviour: Behaviour = { kind: 'heuristic' }): AIAnalyzer {
  switch (behaviour.kind) {
    case 'heuristic':
      return LocalAnalyzer();
    case 'fixed':
      return fixedAnalyzer(behaviour);
    case 'unavailable':
      return unavailableAnalyzer(behaviour.message);
  }
}

export type Behaviour =
  | { readonly kind: 'heuristic' }
  | { readonly kind: 'fixed'; readonly extraction: Partial<ClaimExtraction> }
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
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult> {
      recordOk(observer, 'fake-fixed-v1');
      return Promise.resolve({
        extraction,
        proposal: {
          suggestedDecision: 'approved',
          suggestedAmountCents: extraction.claimedAmountCents ?? 0,
          confidence: extraction.confidence,
          reason: extraction.reason,
          model: 'fake-fixed-v1',
        },
        model: 'fake-fixed-v1',
      });
    },
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
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult> {
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
