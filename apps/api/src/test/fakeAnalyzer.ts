import type { ClaimExtraction } from '@refund/shared';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type IntakeInput,
  type IntakeReply,
  type AttemptObserver,
  type ChatInput,
  type ChatReply,
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
 * - `askItems(candidates, then)` does the same for the item picker: the model
 *   nominates lines it could not tell apart, then decides once the customer has
 *   answered. Separate from `ask` because the picker and a question are different
 *   exits, and a test that wants one must not get the other.
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
    case 'askItems':
      return askItemsAnalyzer(behaviour);
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
  | {
      /** The model asking which line a claim is about, before submitting one. */
      readonly kind: 'askItems';
      /** The item ids the model could not tell apart. */
      readonly candidates: readonly string[];
      /** The claim once the customer has chosen. */
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
    analyze(_input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> {
      recordOk(observer, 'fake-fixed-v1');
      return Promise.resolve(completeReply(extraction, 'fake-fixed-v1'));
    },
    chat(_input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
      observer({
        model: 'fake-fixed-v1',
        attempt: 1,
        ok: true,
        latencyMs: 0,
        promptTokens: null,
        completionTokens: null,
        error: null,
      });
      return Promise.resolve({ kind: 'text', text: "I'm here to help while your agent reviews your case.", model: 'fake-fixed-v1' });
    },
  };
}

/**
 * The picker's double: a request for the picker, then a decided claim.
 *
 * Shaped like the `ask` double on purpose - a cold turn asks, and the turn after
 * the customer has chosen decides - because that is the arc the feature supports.
 * The candidates are passed through unvalidated, which is the point: the test that
 * matters is the one where they are bogus and the server declines.
 */
function askItemsAnalyzer(behaviour: {
  readonly candidates: readonly string[];
  readonly then: Partial<ClaimExtraction>;
}): AIAnalyzer {
  const extraction = { ...BASE_EXTRACTION, ...behaviour.then };
  return {
    label: 'fake (test)',
    model: 'fake-ask-items-v1',
    available: true,
    unavailableReason: null,
    analyze(input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> {
      recordOk(observer, 'fake-ask-items-v1');
      if (input.history.length === 0) {
        return Promise.resolve({
          kind: 'ask_items',
          candidates: behaviour.candidates,
          model: 'fake-ask-items-v1',
        });
      }
      return Promise.resolve(completeReply(extraction, 'fake-ask-items-v1'));
    },
    chat(_input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
      observer({
        model: 'fake-ask-items-v1',
        attempt: 1,
        ok: true,
        latencyMs: 0,
        promptTokens: null,
        completionTokens: null,
        error: null,
      });
      return Promise.resolve({ kind: 'text', text: "I'm here to help while your agent reviews your case.", model: 'fake-ask-items-v1' });
    },
  };
}

function completeReply(extraction: ClaimExtraction, model: string): IntakeReply {
  return {
    kind: 'complete',
    extraction,
    model,
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
    analyze(input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> {
      recordOk(observer, 'fake-ask-v1');
      if (input.history.length === 0) {
        return Promise.resolve({ kind: 'question', question: behaviour.question, model: 'fake-ask-v1' });
      }
      return Promise.resolve(completeReply(extraction, 'fake-ask-v1'));
    },
    chat(_input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
      observer({
        model: 'fake-ask-v1',
        attempt: 1,
        ok: true,
        latencyMs: 0,
        promptTokens: null,
        completionTokens: null,
        error: null,
      });
      return Promise.resolve({ kind: 'text', text: "I'm here to help while your agent reviews your case.", model: 'fake-ask-v1' });
    },
  };
}

function unavailableAnalyzer(message: string): AIAnalyzer {
  return {
    label: 'fake (test)',
    model: 'fake-unavailable-v1',
    available: false,
    unavailableReason: message,
    analyze(_input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> {
      recordOk(observer, 'fake-unavailable-v1');
      return Promise.reject(new AiUnavailableError(message));
    },
    chat(_input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
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
