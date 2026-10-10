import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { z } from 'zod';
import { ClaimExtractionSchema } from '@refund/shared';
import { breakerConfig } from '../config/env.js';
import { ModelCircuitBreaker, runCandidates, unavailableFrom } from './breaker.js';
import { fallbackModels, presetFor, type Env, type ProviderPreset } from '../config/env.js';
import { redactSecrets } from '../lib/redact.js';
import { buildCaseSummaryUser, buildClarifyUser, buildIntakeUser, buildPhraseUser, CASE_SUMMARY_SYSTEM, CLARIFY_SYSTEM, INTAKE_SYSTEM, PHRASE_SYSTEM } from './prompts.js';
import { IntakeOutputSchema, PhraseReplySchema, parseCaseNote, type IntakeOutput } from './schemas.js';
import type { AttemptOutcome } from './breaker.js';
import { parseJson } from './json.js';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type IntakeInput,
  type CaseSummaryInput,
  type ClarifyInput,
  type IntakeReply,
  type AnalyzerOrder,
  type AttemptObserver,
  type PhraseInput,
} from './analyzer.js';
import type { OrderRecord } from '../db/records.js';

/** A currency-marked figure has no business in a clarifying question. */
function hasMoneyFigure(text: string): boolean {
  return /\$\s?\d/.test(text);
}

/**
 * The production analyzer: one HTTP client for every OpenAI-compatible endpoint
 * (Groq, OpenRouter, OpenAI).
 *
 * The differences between those three are a base URL, a key and a couple of
 * headers, so they are configuration rather than subclasses. What this class
 * owns is the part that makes a free model endpoint safe to depend on:
 * candidate models, bounded retries under a total time budget, JSON-mode
 * requests, Zod validation, and a single repair attempt when the model returns
 * something unusable.
 *
 * Failure is expected and cheap here. By the time this runs, every rule has
 * already been evaluated on order facts alone, so an unreachable model costs the
 * explanation some detail and never costs a decision.
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Asks an OpenAI-compatible provider not to spend tokens on reasoning.
 *
 * Sent through `extra_body` because a chat-template argument is not an SDK
 * parameter, and that option exists precisely for sending one anyway.
 */
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/**
 * The thinking switch for the model actually being called.
 *
 * `chat_template_kwargs.enable_thinking` is a Qwen-template knob: gpt-oss
 * reasons in Harmony instead, so it means nothing to it and the model spends
 * the whole token budget thinking before emitting any JSON - which comes back
 * `finish_reason: length` and escalates a readable claim. gpt-oss answers to
 * its own documented knob, `reasoning_effort`, and `low` is enough for an
 * extraction that only has to read a message, not solve anything.
 */
function thinkingExtras(model: string): Record<string, unknown> {
  if (/gpt-oss/i.test(model)) {
    return { reasoning_effort: 'low' };
  }
  return NO_THINKING;
}

/** Derived from the client, so an SDK restructure cannot break it. */
/**
 * A non-streaming completion request, plus whatever the provider understands.
 *
 * The second half of the type is the point. `chat_template_kwargs` is a
 * chat-template argument, not an SDK parameter - the SDK removed `extra_body` in v7
 * and its request types do not model provider-specific fields - so the body is widened
 * by exactly one index signature rather than cast at each call. Nothing here is
 * `any`, and every provider-specific field we send goes through this one door.
 */
type CompletionRequest = Parameters<OpenAI['chat']['completions']['create']>[0];

type CompletionReply = Omit<
  Extract<Awaited<ReturnType<OpenAI['chat']['completions']['create']>>, { choices: readonly unknown[] }>,
  '_request_id'
> & { readonly _request_id?: string | null | undefined };
const MAX_REPAIRS = 1;
/** A case note is a paragraph. Asking for more spends the customer's latency on prose. */
const CASE_SUMMARY_TOKENS = 220;
/** A chat answer is a few sentences. Longer is not friendlier, only slower. */
const GENERAL_TOKENS = 300;
/** A clarifying question is one sentence. Anything longer is a paragraph wearing a question mark. */
const CLARIFY_TOKENS = 150;
/** A model-written question must fit the ask exit it replaces. */
const MAX_QUESTION_CHARS = 400;

/** A failure message is for a human reading a drawer, not a log archive. */
const MAX_ERROR_LENGTH = 500;

export interface ProviderFailure {
  /** Already redacted and length-capped, safe to persist and to display. */
  readonly error: string;
  readonly retryable: boolean;
}

/** An empty completion, which means the endpoint is not serving that model. */
class EmptyCompletionError extends Error {
  constructor() {
    super('model returned an empty completion');
    this.name = 'EmptyCompletionError';
  }
}

/**
 * The model ran out of tokens mid-answer.
 *
 * Worth its own class because the fix is a configuration change rather than a
 * retry: either the model is given a bigger `AI_MAX_TOKENS`, or a different
 * candidate is used. Saying so in the audit line is the difference between a
 * five-minute debugging session and a one-line config edit.
 */
class TruncatedCompletionError extends Error {
  constructor() {
    super('model hit the token limit before finishing its answer');
    this.name = 'TruncatedCompletionError';
  }
}

/**
 * Decides whether an attempt is worth repeating, and produces the text that
 * goes in the audit trail.
 *
 * The unknown-error branch is the important one: an error type this function has
 * never seen is a bug in this codebase, not a flaky provider. Retrying it would
 * multiply the cost of the bug and then report it as "provider down", which is
 * how an outage becomes a mystery.
 */
export function classifyProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof APIUserAbortError) {
    return { error: 'aborted: analysis time budget exhausted', retryable: false };
  }
  if (error instanceof TruncatedCompletionError) {
    // Non-retryable for the same reason: a model that cannot finish inside
    // AI_MAX_TOKENS will not finish inside it on the next attempt either.
    return { error: error.message, retryable: false };
  }
  if (error instanceof EmptyCompletionError) {
    // Not retryable, and this was found the hard way: OpenRouter's
    // `openrouter/free` router answers 200 with an empty body when it cannot
    // route. Asking it twice costs a round trip and changes nothing, so the
    // adapter fails over to the next candidate instead.
    return { error: error.message, retryable: false };
  }
  if (error instanceof APIConnectionError) {
    // Includes APIConnectionTimeoutError: hitting the per-request timeout is a
    // network event, and the next candidate model may well be fast.
    return { error: cap(`connection: ${error.message}`), retryable: true };
  }
  if (error instanceof APIError) {
    const status = statusOf(error as APIError<number | undefined>);
    return {
      error: cap(`HTTP ${status ?? 0}: ${error.message}`),
      retryable: status !== null && RETRYABLE_STATUS.has(status),
    };
  }
  return { error: cap(`unexpected: ${describe(error)}`), retryable: false };
}

/** The HTTP status, or null. */
function statusOf(error: APIError<number | undefined>): number | null {
  const status: unknown = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cap(message: string): string {
  return redactSecrets(message).slice(0, MAX_ERROR_LENGTH);
}

/** Primary model first, then any configured fallbacks, de-duplicated. */
export function modelCandidates(env: Env): string[] {
  const primary = env.AI_MODEL ?? presetFor(env.AI_PROVIDER).defaultModel;
  return [...new Set([primary, ...fallbackModels(env)])].filter((model) => model.length > 0);
}

interface TokenUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

export class OpenAiAnalyzer implements AIAnalyzer {
  readonly label: string;
  readonly model: string;

  /**
   * Dynamic, and that is the point.
   *
   * A model whose circuit is open cannot serve the next request, so reporting the
   * analyzer as available while every candidate is tripped would be a lie told to
   * the storefront and to `/api/health`. `/api/shop/assistant-status` is what the
   * customer-facing page reads, so this is how a provider outage stops looking like
   * "the assistant is thinking".
   */
  get available(): boolean {
    return this.breaker.reason(this.candidates) === null;
  }

  get unavailableReason(): string | null {
    return this.breaker.reason(this.candidates);
  }

  private readonly client: OpenAI;
  private readonly candidates: readonly string[];
  private readonly jsonMode: boolean;
  /**
   * Per-instance, so a test that builds its own analyzer cannot inherit another
   * test's view of a provider. See `breaker.ts` for why not a process-wide registry.
   */
  private readonly breaker: ModelCircuitBreaker;

  constructor(
    private readonly env: Env,
    preset: ProviderPreset,
    apiKey: string,
  ) {
    this.label = preset.label;
    this.jsonMode = preset.jsonMode;
    this.candidates = modelCandidates(env);
    this.breaker = new ModelCircuitBreaker(breakerConfig(env));
    this.model = this.candidates[0] ?? 'unknown';
    this.breaker = new ModelCircuitBreaker(breakerConfig(env));
    this.client = new OpenAI({
      apiKey,
      baseURL: env.AI_BASE_URL ?? preset.baseUrl,
      timeout: env.AI_TIMEOUT_MS,
      maxRetries: 0,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/eL-iam123/refund-ai-support',
        'X-Title': 'Refund AI Support',
      },
    });
  }

  /**
   * Intake: the model either asks one question or submits a complete claim.
   *
   * One repair attempt, not a retry storm. The failure this defends against is a
   * model that returned prose or half a schema, and repeating a request that was
   * structurally wrong usually produces the same shape of wrong - so the retry
   * carries the specific complaint and hopes for a fix, while transport failures
   * are handled by `complete` below, which is the layer that knows about
   * candidates and backoff.
   */
  async analyze(input: IntakeInput, observer: AttemptObserver): Promise<IntakeReply> {
    const budget = AbortSignal.timeout(this.env.AI_TOTAL_BUDGET_MS);
    const base = buildIntakeUser(
      input.message,
      input.order,
      input.history,
      this.env.AI_SHARE_ORDER_FACTS,
      input.allowedExits,
    );
    let complaints = 'no completion';

    for (let repair = 0; repair <= MAX_REPAIRS; repair += 1) {
      const user =
        repair === 0
          ? base
          : `${base}\n\nYour previous reply was rejected: ${complaints}. Reply with valid JSON only.`;

      const completion = await this.complete(INTAKE_SYSTEM, user, budget, observer, 'intake');
      const parsed = IntakeOutputSchema.safeParse(parseJson(completion.text));

      if (parsed.success) {
        return toIntakeReply(parsed.data, completion.model);
      }

      complaints = formatIssues(parsed.error).slice(0, 300);
      observer({
        model: completion.model,
        attempt: repair + 1,
        ok: false,
        latencyMs: 0,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        error: `schema: ${complaints}`,
      });

      if (budget.aborted) {
        break;
      }
    }

    throw new AiUnavailableError(
      budget.aborted
        ? `intake time budget of ${this.env.AI_TOTAL_BUDGET_MS}ms exhausted; last problem: ${complaints}`
        : `model output failed schema validation: ${complaints}`,
    );
  }


  /**
   * Phrases a decided outcome into customer-facing prose.
   *
   * Same transport contract as every other prose call: one candidate walk,
   * schema-bounded length, null on any failure. Content safety is the
   * caller's job (envelope-match validation), not the transport's - this
   * method cannot tell a good phrasing from a lying one, it can only tell an
   * empty or overlong one.
   */
  async phrase(input: PhraseInput, observer: AttemptObserver): Promise<string | null> {
    const budget = AbortSignal.timeout(this.env.AI_TOTAL_BUDGET_MS);
    const user = buildPhraseUser(input);
    const result = await runCandidates<string>({
      candidates: this.candidates,
      maxAttempts: this.env.AI_MAX_ATTEMPTS,
      breaker: this.breaker,
      budget,
      purpose: 'phrase',
      attempt: async (model, attempt) => this.phraseAttempt(model, attempt, user, budget, observer),
    });
    if (!result.ok) {
      return null;
    }
    return result.value;
  }

  /**
   * Words one missing detail as a question.
   *
   * Same transport contract as phrasing: one candidate walk, and null on any
   * failure - the caller falls back to the deterministic question, so a model
   * that cannot ask plainly costs a round trip, never the turn. Content safety
   * is structural here rather than validated: the prompt carries names and
   * kinds but no figures, and the question guard still checks the result for
   * repeats before anyone reads it.
   */
  async askClarification(input: ClarifyInput, observer: AttemptObserver): Promise<string | null> {
    const budget = AbortSignal.timeout(this.env.AI_TOTAL_BUDGET_MS);
    const user = buildClarifyUser(input);
    const result = await runCandidates<string>({
      candidates: this.candidates,
      maxAttempts: this.env.AI_MAX_ATTEMPTS,
      breaker: this.breaker,
      budget,
      purpose: 'clarify',
      attempt: async (model, attempt) => this.clarifyAttempt(model, attempt, user, budget, observer),
    });
    if (!result.ok) {
      return null;
    }
    return result.value;
  }

  private async clarifyAttempt(
    model: string,
    attempt: number,
    user: string,
    budget: AbortSignal,
    observer: AttemptObserver,
  ): Promise<AttemptOutcome<string>> {
    const startedAt = Date.now();
    try {
      const completion = await this.createCompletion(
        {
          model,
          temperature: 0.7,
          max_tokens: Math.min(this.env.AI_MAX_TOKENS, CLARIFY_TOKENS),
          messages: [
            { role: 'system', content: CLARIFY_SYSTEM },
            { role: 'user', content: user },
          ],
        },
        budget,
      );
      const text = firstMessage(completion).trim();
      if (text.length === 0 || text.length > MAX_QUESTION_CHARS || hasMoneyFigure(text)) {
        return { ok: false, error: 'clarify reply rejected by validation', retryable: false };
      }
      const usage = readUsage(completion.usage);
      observer({ model, attempt, ok: true, latencyMs: Date.now() - startedAt, ...usage, error: null });
      return { ok: true, value: text };
    } catch (error: unknown) {
      const failure = classifyProviderFailure(error);
      observer({
        model,
        attempt,
        ok: false,
        latencyMs: Date.now() - startedAt,
        promptTokens: null,
        completionTokens: null,
        error: failure.error,
      });
      return { ok: false, ...failure };
    }
  }

  private async phraseAttempt(
    model: string,
    attempt: number,
    user: string,
    budget: AbortSignal,
    observer: AttemptObserver,
  ): Promise<AttemptOutcome<string>> {
    const startedAt = Date.now();
    try {
      const completion = await this.createCompletion(
        {
          model,
          temperature: 0.7,
          max_tokens: Math.min(this.env.AI_MAX_TOKENS, GENERAL_TOKENS),
          messages: [
            { role: 'system', content: PHRASE_SYSTEM },
            { role: 'user', content: user },
          ],
        },
        budget,
      );
      const text = firstMessage(completion).trim();
      if (text.length === 0) {
        return { ok: false, error: 'phrase reply was empty', retryable: false };
      }
      const parsed = PhraseReplySchema.safeParse(text);
      if (!parsed.success) {
        return { ok: false, error: 'phrase reply rejected by validation', retryable: false };
      }
      const usage = readUsage(completion.usage);
      observer({ model, attempt, ok: true, latencyMs: Date.now() - startedAt, ...usage, error: null });
      return { ok: true, value: parsed.data };
    } catch (error: unknown) {
      const failure = classifyProviderFailure(error);
      observer({
        model,
        attempt,
        ok: false,
        latencyMs: Date.now() - startedAt,
        promptTokens: null,
        completionTokens: null,
        error: failure.error,
      });
      return { ok: false, ...failure };
    }
  }


  /**
   * The case note, in one call, or null.
   *
   * No ladder and no repair pass: a summary is not worth a queue of provider attempts,
   * and a provider that cannot manage one sentence is not a reason to spend the next.
   * Every failure path returns null, because the alternative - throwing - would let a
   * missing sentence fail a refund.
   */
  async summariseCase(input: CaseSummaryInput, observer: AttemptObserver): Promise<string | null> {
    if (input.verifiedQuotes.length === 0) {
      return null;
    }
    const budget = AbortSignal.timeout(this.env.AI_TOTAL_BUDGET_MS);
    const startedAt = Date.now();
    try {
      const completion = await this.createCompletion(
        {
          model: this.candidates[0] ?? 'unknown',
          temperature: 0,
          // A short paragraph, and a ceiling that makes "a short paragraph" enforceable
          // rather than aspirational.
          max_tokens: Math.min(this.env.AI_MAX_TOKENS, CASE_SUMMARY_TOKENS),
          messages: [
            { role: 'system', content: CASE_SUMMARY_SYSTEM },
            { role: 'user', content: buildCaseSummaryUser(input) },
          ],
        },
        budget,
      );
      const text = firstMessage(completion);
      const note = parseCaseNote(text, input.outcome.amountCents);
      if (note === null) {
        observer({
          model: completion.model, attempt: 1, ok: false, latencyMs: Date.now() - startedAt,
          promptTokens: null, completionTokens: null, error: 'case summary rejected by validation',
        });
        return null;
      }
      observer({
        model: completion.model, attempt: 1, ok: true, latencyMs: Date.now() - startedAt,
        promptTokens: null, completionTokens: null, error: null,
      });
      return note;
    } catch (error: unknown) {
      const failure = classifyProviderFailure(error);
      observer({
        model: this.model, attempt: 1, ok: false, latencyMs: Date.now() - startedAt,
        promptTokens: null, completionTokens: null, error: failure.error,
      });
      return null;
    }
  }

  /**
   * One completion, with thinking switched off where the provider honours it.
   *
   * A reasoning model spends its token budget thinking before it emits anything, and
   * `max_tokens` covers both. Measured against one provider: a 27-token prompt drew
   * 245 characters of reasoning for 7 tokens of JSON, and the full intake prompt drew
   * reasoning alone - long enough that `finish_reason` came back `length`, which this
   * adapter treats as unusable. Every claim escalated to a person, which looked
   * exactly like the assistant being broken.
   *
   * A provider that rejects the extra field answers 400 and the call is retried once
   * without it, so this is an optimisation that cannot break a deployment which has
   * never heard of it.
   */
  private async createCompletion(body: CompletionRequest, budget: AbortSignal): Promise<CompletionReply> {
    const withExtras = this.env.AI_DISABLE_THINKING ? { ...body, ...thinkingExtras(body.model) } : body;
    try {
      // The cast is at a third-party typing boundary and is deliberate:
      // Both casts are at one third-party typing boundary and are deliberate.
      // `chat_template_kwargs` is a provider chat-template argument, and the SDK's
      // request types do not model provider-specific fields (v7 removed `extra_body`
      // entirely), so widening the body to send it is unavoidable. The answer is
      // narrowed back to the non-streaming shape: no call in this file streams, and
      // the SDK's return type is a union with the streaming form, which under
      // `exactOptionalPropertyTypes` will not accept the SDK's own declared
      // `_request_id`.
      //
      // A provider that rejects the unknown field answers 400 and the call is retried
      // immediately below without it, so this cannot break a deployment that has never
      // heard of the argument.
      return (await this.client.chat.completions.create(withExtras, { signal: budget })) as CompletionReply;
    } catch (error: unknown) {
      if (!this.env.AI_DISABLE_THINKING || !(error instanceof APIError) || error.status !== 400) {
        throw error;
      }
      return (await this.client.chat.completions.create(body, { signal: budget })) as CompletionReply;
    }
  }

  /**
   * Tries each candidate model in turn, retrying each with a fixed backoff, and
   * skips whatever the breaker already has open.
   *
   * The ladder itself - including the backoff and the failure text - is in
   * `breaker.ts`, shared with the other adapter and with chat mode. What is left
   * here is the part that is genuinely this wire format: one HTTP call and the
   * reading of its answer.
   */
  private async complete(
    system: string,
    user: string,
    budget: AbortSignal,
    observer: AttemptObserver,
    purpose: string,
  ): Promise<Completion> {
    const result = await runCandidates<Completion>({
      candidates: this.candidates,
      maxAttempts: this.env.AI_MAX_ATTEMPTS,
      breaker: this.breaker,
      budget,
      purpose,
      attempt: async (model, attempt) => {
        const outcome = await this.attempt(model, attempt, system, user, budget, observer);
        return outcome.ok ? { ok: true, value: outcome.completion } : outcome;
      },
    });
    if (!result.ok) {
      throw unavailableFrom(result);
    }
    return result.value;
  }

  /** What `/api/health` publishes: the breaker's view, not a probe. */
  breakerState(): ReturnType<NonNullable<AIAnalyzer['breakerState']>> {
    return this.breaker.snapshot(this.candidates);
  }


  private async attempt(
    model: string,
    attempt: number,
    system: string,
    user: string,
    budget: AbortSignal,
    observer: AttemptObserver,
  ): Promise<Attempt> {
    const startedAt = Date.now();
    try {
      const completion = await this.createCompletion(
        {
          model,
          temperature: 0,
          max_tokens: this.env.AI_MAX_TOKENS,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(this.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        },
        budget,
      );

      const text = firstMessage(completion);
      if (text.trim().length === 0) {
        throw new EmptyCompletionError();
      }
      if (completion.choices[0]?.finish_reason === 'length') {
        throw new TruncatedCompletionError();
      }

      const usage = readUsage(completion.usage);
      observer({ model, attempt, ok: true, latencyMs: Date.now() - startedAt, ...usage, error: null });
      return { ok: true, completion: { text, model, ...usage } };
    } catch (error: unknown) {
      const failure = classifyProviderFailure(error);
      observer({
        model,
        attempt,
        ok: false,
        latencyMs: Date.now() - startedAt,
        promptTokens: null,
        completionTokens: null,
        error: failure.error,
      });
      return { ok: false, ...failure };
    }
  }

}


/**
 * The validated wire object as an `IntakeReply`.
 *
 * The claim is re-parsed through the extraction schema on the way in rather than
 * spread out of the wire object, because that parse is what strips the `action`
 * discriminator and anything else the model invented: what the engine receives is
 * the extraction schema and nothing else.
 */
function toIntakeReply(data: IntakeOutput, model: string): IntakeReply {
  if (data.action === 'ask_items') {
    return { kind: 'ask_items', candidates: data.candidates, model };
  }
  if (data.action === 'ask') {
    return { kind: 'question', question: data.question, model };
  }
  return { kind: 'complete', extraction: ClaimExtractionSchema.parse(data), model };
}

interface Completion {
  readonly text: string;
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

type Attempt =
  | { readonly ok: true; readonly completion: Completion }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

/**
 * Token counts are kept because they are the only cost signal the audit table
 * has. A null here means the endpoint did not report usage, not zero spend.
 */
function readUsage(usage: OpenAI.Chat.Completions.ChatCompletion['usage']): TokenUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
  };
}

function firstMessage(completion: OpenAI.Chat.Completions.ChatCompletion): string {
  return completion.choices[0]?.message.content ?? '';
}

/**
 * Sleeps between attempts, and gives up the moment the budget is spent.
 *
 * The backoff flattens at the last value rather than falling through to zero:
 * with `AI_MAX_ATTEMPTS=5` a zero-delay third retry would hammer an endpoint that
 * has already told us twice that it is busy.
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
    .join('; ');
}

/** Flattens a database record into the summary the AI layer is allowed to see. */
export function toAnalyzerOrder(order: OrderRecord | null): AnalyzerOrder | null {
  if (order === null) {
    return null;
  }
  return {
    id: order.id,
    totalCents: order.totalCents,
    status: order.status,
    paymentState: order.paymentState,
    ageDays: order.ageDays,
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
  };
}