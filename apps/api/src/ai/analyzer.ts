import type { AiProposal, ClaimExtraction } from '@refund/shared';

/**
 * The one seam between the policy engine and a language model.
 *
 * Everything above this file is provider-agnostic and deterministic. Everything
 * below it is "ask a model to talk to a customer". The interface is deliberately
 * narrow - one method, one job - because the security argument of this system
 * is that the model is a messenger, not a decision maker. Its entire influence
 * is one `AgentReply` that either asks the customer a question or hands the
 * engine a `ClaimExtraction`, and the engine is free to overrule the claim.
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

/** One prior turn of the conversation, oldest first. */
export interface DialogueLine {
  readonly role: 'customer' | 'assistant';
  readonly text: string;
}

/**
 * Input for the intake phase: model extracts structured claim from conversation.
 */
export interface IntakeInput {
  readonly message: string;
  /** Null when no order could be resolved for the customer. */
  readonly order: AnalyzerOrder | null;
  /**
   * The conversation so far, excluding the current message. The model cannot
   * hold state, so the transcript is shipped with every call - a question it
   * asked last turn is the customer's context for this turn.
   */
  readonly history: readonly DialogueLine[];
}

/** One prior turn of the conversation, oldest first. */
export interface DialogueLine {
  readonly role: 'customer' | 'assistant';
  readonly text: string;
}

/**
 * What the model returns during intake.
 *
 * Two options: ask a clarifying question, or submit a complete claim extraction.
 * The model is an intake specialist, NOT a decision maker.
 */
export type IntakeReply =
  | {
      readonly kind: 'question';
      /** Exactly one question, written in the customer's own language. */
      readonly question: string;
      readonly model: string;
    }
  | {
      readonly kind: 'complete';
      readonly extraction: ClaimExtraction;
      readonly model: string;
    };

/**
 * What the model is allowed to do back in the legacy flow (kept for chat mode).
 *
 * Two options, and nothing else. `question` is the messenger half of the job:
 * the model may ask the customer for the one detail it is missing. `claim` is
 * the engine half - a reading of the message, never a decision, that the
 * resolver compares against the policy and is free to overrule. Everything the
 * model says to a customer is a question; everything it decides is a suggestion.
 */
export type AgentReply =
  | {
      readonly kind: 'question';
      /** Exactly one question, written in the customer's own language. */
      readonly question: string;
      readonly model: string;
    }
  | {
      readonly kind: 'claim';
      readonly extraction: ClaimExtraction;
      readonly proposal: AiProposal;
      readonly model: string;
    };

/**
 * Input for chat mode (escalated conversations).
 *
 * The AI acts as a helpful conversational assistant with no monetary authority.
 * It can respond naturally and has one tool: remind_admin.
 */
export interface ChatInput {
  readonly message: string;
  readonly order: AnalyzerOrder | null;
  readonly history: readonly DialogueLine[];
  readonly tools: readonly ChatTool[];
}

/**
 * Tool available in chat mode.
 */
export interface ChatTool {
  readonly name: 'remind_admin';
  readonly description: 'Notify the human agent that the customer is waiting or pushing for a response.';
}

/**
 * Reply in chat mode.
 *
 * Two options: a conversational text response, or a tool call to remind the admin.
 */
export type ChatReply =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly model: string;
    }
  | {
      readonly kind: 'tool_call';
      readonly tool: 'remind_admin';
      readonly model: string;
    };

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
   * Whether a call to a real provider is configured.
   *
   * Not the same as "will this call succeed" - a configured key can still fail,
   * rate-limit or return unusable output, and all three of those are handled at
   * call time. This answers the narrower question of whether there is a key at
   * all, so a deployment can be told "no model configured" at boot rather than
   * discovering it one escalating request at a time.
   */
  readonly available: boolean;
  /**
   * Why it is unavailable, naming the environment variable to set.
   *
   * Null when available. Shown to the storefront, because "the assistant is not
   * working" and "the assistant is working with no model behind it" are
   * different problems with different fixes.
   */
  readonly unavailableReason: string | null;
  /**
   * Intake phase: model extracts structured claim with clarification loops.
   *
   * Rejects with `AiUnavailableError` when no configured model produced
   * schema-valid output. Callers treat that as "no claim", which can only
   * escalate - the decision is computed from order facts either way.
   */
  analyze(input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply>;
  /**
   * Chat mode for escalated conversations.
   *
   * Used when a human agent has taken over but the customer is still chatting.
   * The AI acts as a helpful conversational assistant with no monetary authority.
   * It can respond naturally and has one tool: remind_admin (notifies the human
   * agent that the customer is waiting/pushing).
   */
  chat(input: ChatInput, observer: AttemptObserver): Promise<ChatReply>;
}

/** Every configured model failed, or none of them answered with valid JSON. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}