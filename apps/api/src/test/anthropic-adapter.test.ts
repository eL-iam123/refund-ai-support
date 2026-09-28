import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAnalyzer } from '../ai/anthropicAnalyzer.js';
import { presetFor } from '../config/env.js';
import type { AnalyzerInput, AttemptObserver } from '../ai/analyzer.js';
import { testEnv } from './helpers.js';

/**
 * The native Anthropic wire format.
 *
 * Anthropic has no OpenAI-compatible endpoint, so this adapter speaks the
 * Messages API directly and the two formats differ in a way that fails silently
 * rather than loudly: a `tool_use` block carries the tool's name in `name`, while
 * `id` is a generated `toolu_...` string. Matching on `id` compiles, type-checks,
 * and then rejects every real response - which the adapter cannot tell apart from
 * a model that refused to call the tool, so it burns every retry and reports
 * "model output failed schema validation" on a perfectly good reply.
 *
 * These tests pin the shape rather than the behaviour, because the behaviour when
 * it is wrong is indistinguishable from a provider outage.
 */

const INPUT: AnalyzerInput = {
  message: 'The mug arrived cracked. I would like a refund.',
  order: {
    id: 'ORD-1',
    totalCents: 4200,
    status: 'delivered',
    paymentState: 'captured',
    ageDays: 3,
    items: [{ id: 'MUG', name: 'Ceramic mug', quantity: 1, unitPriceCents: 4200 }],
  },
};

const VALID_INPUT = {
  intent: 'refund',
  reason: 'damaged',
  condition: 'damaged',
  confidence: 0.9,
  orderRef: 'ORD-1',
  claimedAmountCents: 4200,
  items: ['MUG'],
  evidenceQuotes: ['arrived cracked'],
  language: 'en',
  urgency: 'normal',
  policyOverrideAttempted: false,
  suggestedDecision: 'approved',
  suggestedAmountCents: 4200,
};

const noopObserver: AttemptObserver = () => undefined;

function buildAnalyzer() {
  const env = testEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' });
  return new AnthropicAnalyzer(env, presetFor('anthropic'), 'sk-ant-test');
}

/** Answers every call with the given payload, and records what was sent. */
function stubAnthropic(payload: unknown): { calls: Request[] } {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push(new Request(url, init));
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic wire format', () => {
  it('sends a forced tool call to the native messages endpoint', async () => {
    const { calls } = stubAnthropic({ content: [{ type: 'tool_use', name: 'record_refund_claim', input: VALID_INPUT }] });

    await buildAnalyzer().analyze(INPUT, noopObserver);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    if (request === undefined) {
      throw new Error('the analyzer made no request');
    }
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(request.headers.get('anthropic-version')).not.toBeNull();

    const body = (await request.json()) as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_refund_claim' });
    // No OpenAI SDK shape leaks into a request this endpoint will reject.
    expect(body.messages).toHaveLength(1);
    expect(body).not.toHaveProperty('response_format');
  });

  it('reads the claim from the tool block named by the tool, not by its id', async () => {
    // The regression. A real `tool_use` block looks exactly like this: `id` is
    // generated, `name` is what identifies the tool.
    stubAnthropic({
      content: [
        { type: 'text', text: 'Let me check that order.' },
        { type: 'tool_use', id: 'toolu_01ABC', name: 'record_refund_claim', input: VALID_INPUT },
      ],
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 100, output_tokens: 40 },
    });

    const result = await buildAnalyzer().analyze(INPUT, noopObserver);

    expect(result.extraction.reason).toBe('damaged');
    expect(result.extraction.items).toEqual(['MUG']);
    expect(result.proposal.suggestedDecision).toBe('approved');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('ignores a block whose id matches the tool but whose name does not', async () => {
    // Guards against the bug returning: matching on `id` would accept this.
    stubAnthropic({
      content: [{ type: 'tool_use', id: 'record_refund_claim', name: 'some_other_tool', input: VALID_INPUT }],
    });

    // No usable tool call, so the adapter exhausts its retries and reports the
    // provider as unavailable rather than inventing a claim.
    await expect(buildAnalyzer().analyze(INPUT, noopObserver)).rejects.toThrow();
  });

  it('reports an empty completion as a provider failure instead of guessing', async () => {
    stubAnthropic({ content: [{ type: 'text', text: 'I cannot help with that.' }] });

    await expect(buildAnalyzer().analyze(INPUT, noopObserver)).rejects.toThrow();
  });
});
