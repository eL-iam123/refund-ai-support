import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAnalyzer } from '../ai/openaiAnalyzer.js';
import { presetFor } from '../config/env.js';
import { INTAKE_SYSTEM } from '../ai/prompts.js';
import type { IntakeInput, AttemptObserver } from '../ai/analyzer.js';
import { testEnv } from './helpers.js';

/**
 * The OpenAI-compatible request shape.
 *
 * `messages` is a two-element array, and the order is the whole contract: the
 * system prompt states the schema and the two exits, while the user message
 * carries the conversation and the order. Swap them and the request still
 * compiles, still returns HTTP 200, and still burns a few hundred tokens - it
 * just arrives without the schema, so the model writes prose or invents its own
 * keys and every reply fails `IntakeOutputSchema`.
 *
 * That failure is invisible from the outside. The provider records `ok: true`,
 * because the HTTP call succeeded; the schema rejection lands on the next audit
 * row as `schema: (root) Invalid input` with a zero latency, and the request
 * escalates with no extraction and no grounding. It looks exactly like a flaky
 * model. These tests pin the array so that cannot happen quietly again.
 */

const INPUT: IntakeInput = {
  message: 'The mug arrived cracked. I would like a refund.',
  history: [],
  order: {
    id: 'ORD-1',
    totalCents: 4200,
    status: 'delivered',
    paymentState: 'captured',
    ageDays: 3,
    items: [{ id: 'MUG', name: 'Ceramic mug', quantity: 1, unitPriceCents: 4200 }],
  },
};

const VALID_OUTPUT = {
  action: 'decide',
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
};

const noopObserver: AttemptObserver = () => undefined;

function buildAnalyzer() {
  const env = testEnv({ AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'nvapi-test' });
  return new OpenAiAnalyzer(env, presetFor('nvidia'), 'nvapi-test');
}

/** Answers every call with the given assistant content, and records what was sent. */
function stubProvider(content: string): { calls: Request[] } {
  const calls: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push(new Request(url, init));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
  return { calls };
}

async function bodyOf(request: Request): Promise<{
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}> {
  return (await request.json()) as {
    readonly messages: readonly { readonly role: string; readonly content: string }[];
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the OpenAI-compatible extraction request', () => {
  it('puts the system prompt first and the conversation second', async () => {
    // The regression. `complete(system, user)` was being called as
    // `complete(base, user)` - the user message twice, and no system prompt at
    // all. The model answered a request that never mentioned the schema.
    const { calls } = stubProvider(JSON.stringify(VALID_OUTPUT));

    await buildAnalyzer().analyze(INPUT, noopObserver);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    if (request === undefined) {
      throw new Error('the analyzer made no request');
    }
    const body = await bodyOf(request);

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toBe(INTAKE_SYSTEM);
    expect(body.messages[1]?.role).toBe('user');

    // The schema has to actually be in the prompt. Without it the model is
    // guessing field names, which is the failure this test exists to catch.
    expect(body.messages[0]?.content).toContain('ask_question');
    expect(body.messages[0]?.content).toContain('decide_claim');
    expect(body.messages[1]?.content).toContain('The mug arrived cracked.');
    expect(body.messages[1]?.content).not.toBe(body.messages[0]?.content);
  });

  it('keeps the system prompt in place for the repair attempt', async () => {
    // A repair adds the rejection to the *user* message. If the schema only
    // arrived in the system message, the retry would have it too - but only
    // because the system slot is filled correctly. This asserts the retry still
    // sends both, because the first reply is the one most likely to have drifted.
    const { calls } = stubProvider('this is not JSON at all');

    await buildAnalyzer()
      .analyze(INPUT, noopObserver)
      .catch(() => undefined);

    expect(calls).toHaveLength(2);
    const retry = calls[1];
    if (retry === undefined) {
      throw new Error('no repair attempt was made');
    }
    const body = await bodyOf(retry);
    expect(body.messages[0]?.content).toBe(INTAKE_SYSTEM);
    expect(body.messages[1]?.content).toContain('Your previous reply was rejected');
  });

  it('asks for JSON from the provider, since the preset declares json mode', async () => {
    const { calls } = stubProvider(JSON.stringify(VALID_OUTPUT));

    await buildAnalyzer().analyze(INPUT, noopObserver);

    const request = calls[0];
    if (request === undefined) {
      throw new Error('the analyzer made no request');
    }
    expect((await request.json()) as Record<string, unknown>).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });
});