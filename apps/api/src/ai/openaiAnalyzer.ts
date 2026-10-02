import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { z } from 'zod';
import { ClaimExtractionSchema } from '@refund/shared';
import { fallbackModels, presetFor, type Env, type ProviderPreset } from '../config/env.js';
import { redactSecrets } from '../lib/redact.js';
import { buildIntakeUser, CHAT_SYSTEM_PROMPT, INTAKE_SYSTEM } from './prompts.js';
import { IntakeOutputSchema, type IntakeOutput } from './schemas.js';
import { parseJson } from './json.js';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type IntakeInput,
  type IntakeReply,
  type AnalyzerOrder,
  type AttemptObserver,
  type ChatInput,
  type ChatReply,
} from './analyzer.js';
import type { OrderRecord } from '../db/records.js';
import { setTimeout as sleep } from 'node:timers/promises';

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
/** 400ms, then 1200ms, and 1200ms again: never a zero-delay retry. */
const BACKOFF_MS = [400, 1200] as const;
const MAX_REPAIRS = 1;
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
  readonly available = true;
  readonly unavailableReason = null;

  private readonly client: OpenAI;
  private readonly candidates: readonly string[];
  private readonly jsonMode: boolean;

  constructor(
    private readonly env: Env,
    preset: ProviderPreset,
    apiKey: string,
  ) {
    this.label = preset.label;
    this.jsonMode = preset.jsonMode;
    this.candidates = modelCandidates(env);
    this.model = this.candidates[0] ?? 'unknown';
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
    const base = buildIntakeUser(input.message, input.order, input.history, this.env.AI_SHARE_ORDER_FACTS);
    let complaints = 'no completion';

    for (let repair = 0; repair <= MAX_REPAIRS; repair += 1) {
      const user =
        repair === 0
          ? base
          : `${base}\n\nYour previous reply was rejected: ${complaints}. Reply with valid JSON only.`;

      const completion = await this.complete(INTAKE_SYSTEM, user, budget, observer);
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

  /** Tries each candidate model in turn, retrying each with a fixed backoff. */
  private async complete(
    system: string,
    user: string,
    budget: AbortSignal,
    observer: AttemptObserver,
  ): Promise<Completion> {
    const failures: string[] = [];

    for (const model of this.candidates) {
      for (let attempt = 1; attempt <= this.env.AI_MAX_ATTEMPTS; attempt += 1) {
        if (budget.aborted) {
          throw new AiUnavailableError(`intake time budget exhausted after ${failures.length} attempt(s)`);
        }

        const outcome = await this.attempt(model, attempt, system, user, budget, observer);
        if (outcome.ok) {
          return outcome.completion;
        }
        failures.push(`${model}#${attempt} ${outcome.error}`);

        const canRetry = attempt < this.env.AI_MAX_ATTEMPTS && outcome.retryable;
        if (!canRetry) {
          break;
        }
        await backoff(attempt, budget);
      }
    }

    throw new AiUnavailableError(
      cap(`all ${this.candidates.length} model(s) failed after ${failures.length} attempt(s): ${failures.join(' | ')}`),
    );
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
      const completion = await this.client.chat.completions.create(
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
        { signal: budget },
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

  async chat(input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
    const budget = AbortSignal.timeout(this.env.AI_TOTAL_BUDGET_MS);
    const messages = chatMessages(input);

    for (const model of this.candidates) {
      for (let attempt = 1; attempt <= this.env.AI_MAX_ATTEMPTS; attempt += 1) {
        if (budget.aborted) {
          throw new AiUnavailableError(`chat time budget exhausted`);
        }

        const startedAt = Date.now();
        try {
          const completion = await this.client.chat.completions.create(
            {
              model,
              temperature: 0.7,
              max_tokens: this.env.AI_MAX_TOKENS,
              messages,
              ...(input.tools.length > 0 ? { tools: [REMIND_FUNCTION], tool_choice: 'auto' as const } : {}),
            },
            { signal: budget },
          );

          const answer = chatAnswer(completion, model);
          if (answer === null) {
            continue;
          }

          observer({
            model,
            attempt,
            ok: true,
            latencyMs: Date.now() - startedAt,
            promptTokens: null,
            completionTokens: null,
            error: null,
          });
          return answer;
        } catch (error) {
          const failure = classifyProviderFailure(error);
          if (!failure.retryable || attempt >= this.env.AI_MAX_ATTEMPTS) {
            continue;
          }
        }
      }
    }

    throw new AiUnavailableError(`all ${this.candidates.length} model(s) failed for chat`);
  }
}

/** The chat-mode tool declaration, in OpenAI function-calling shape. */
const REMIND_FUNCTION = {
  type: 'function' as const,
  function: {
    name: 'remind_admin',
    description: 'Notify the human agent that the customer is waiting or pushing for a response.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

function chatMessages(input: ChatInput): { role: 'system' | 'user'; content: string }[] {
  const historyText = input.history.map((line) => `${line.role}: ${line.text}`).join('\n');
  const toolText = input.tools.map((t) => t.name).join(', ');
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Customer message: ${input.message}\n\nConversation history:\n${historyText}\n\nAvailable tools: ${toolText}`,
    },
  ];
}

/**
 * Reads the turn's answer off the completion: a `remind_admin` tool call if the
 * model reached for one, otherwise its prose. Null means the model said nothing
 * usable, which is a miss worth another attempt rather than a reply to send.
 */
function chatAnswer(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): ChatReply | null {
  const message = completion.choices[0]?.message;
  const toolCall = message?.tool_calls?.[0];
  if (toolCall !== undefined && 'function' in toolCall && toolCall.function.name === 'remind_admin') {
    return { kind: 'tool_call', tool: 'remind_admin', model };
  }

  const text = message?.content ?? '';
  return text.trim().length === 0 ? null : { kind: 'text', text, model };
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
async function backoff(attempt: number, budget: AbortSignal): Promise<void> {
  const last = BACKOFF_MS.length - 1;
  const wait = BACKOFF_MS[Math.min(attempt - 1, last)] ?? BACKOFF_MS[last];
  try {
    await sleep(wait, undefined, { signal: budget });
  } catch (error: unknown) {
    if (budget.aborted) {
      throw new AiUnavailableError('analysis time budget exhausted while backing off');
    }
    throw error;
  }
}

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