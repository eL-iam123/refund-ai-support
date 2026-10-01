import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { classifyProviderFailure, modelCandidates, toAnalyzerOrder } from '../ai/openaiAnalyzer.js';
import { parseJson } from '../ai/json.js';
import { LocalAnalyzer } from '../ai/localAnalyzer.js';
import { ExtractionOutputSchema } from '../ai/schemas.js';
import { redactSecrets } from '../lib/redact.js';
import { testEnv } from './helpers.js';
import { missingApiKeyFor, presetFor, readEnv, requiresApiKey } from '../config/env.js';
import type { OrderRecord } from '../db/records.js';

/**
 * Tests for the model boundary itself.
 *
 * The scenario suite proves the policy is right given a claim. These prove the
 * claim arrives intact, the retry logic cannot amplify a bug, and no credential
 * can reach the audit trail.
 */

describe('the local extractor leaves a greeting to the messenger', () => {
  it('asks what happened rather than claiming, when nothing is wrong yet', async () => {
    const reply = await LocalAnalyzer().analyze({ message: 'hello', order: null, history: [] }, () => {});

    expect(reply.kind).toBe('question');
    if (reply.kind === 'question') {
      expect(reply.question).toContain('what happened');
    }
  });

  it('does not lose a multi-word greeting or a standalone thanks', async () => {
    for (const message of ['Hi there!', 'hello', 'thanks', 'thank you', 'hola', 'bonjour']) {
      const reply = await LocalAnalyzer().analyze({ message, order: null, history: [] }, () => {});
      expect(reply.kind, message).toBe('question');
    }
  });

  it('asks for more detail before claiming a bare complaint', async () => {
    const reply = await LocalAnalyzer().analyze(
      {
        message: 'the mug is damaged',
        order: { id: 'ORD-1', totalCents: 100, status: 'delivered', paymentState: 'settled', ageDays: 3, items: [] },
        history: [],
      },
      () => {},
    );

    expect(reply.kind).toBe('question');
    if (reply.kind === 'question') {
      expect(reply.question).toContain('what the damage looks like');
    }
  });

  it('names the missing order when none is resolved yet, in the customer’s language', async () => {
    const reply = await LocalAnalyzer().analyze({ message: 'hola', order: null, history: [] }, () => {});
    expect(reply.kind).toBe('question');
    if (reply.kind === 'question') {
      expect(reply.question).toMatch(/pedido/);
    }
  });

  it('still claims a real complaint, including a vague one ("It’s just not right")', async () => {
    const vague = await LocalAnalyzer().analyze(
      { message: "It's just not right. Can you sort it out?", order: null, history: [] },
      () => {},
    );
    expect(vague.kind).toBe('claim');

    const damaged = await LocalAnalyzer().analyze(
      { message: 'hello, my lamp arrived cracked', order: { id: 'ORD-1', totalCents: 100, status: 'delivered', paymentState: 'settled', ageDays: 3, items: [] }, history: [] },
      () => {},
    );
    expect(damaged.kind).toBe('claim');
    if (damaged.kind === 'claim') {
      expect(damaged.extraction.reason).toBe('damaged');
    }
  });
});

describe('retry classification', () => {
  it('retries the failures a flaky provider actually produces', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyProviderFailure(new APIError(status, undefined, 'busy', undefined)).retryable, `${status}`).toBe(
        true,
      );
    }
    expect(classifyProviderFailure(new APIConnectionError({ message: 'ECONNRESET' })).retryable).toBe(true);
    expect(classifyProviderFailure(new APIConnectionTimeoutError({ message: 'timed out' })).retryable).toBe(true);
  });

  it('does not retry a rejection, because asking again will be rejected again', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyProviderFailure(new APIError(status, undefined, 'nope', undefined)).retryable, `${status}`).toBe(
        false,
      );
    }
  });

  it('does not retry an unknown error, which is a bug here rather than bad luck there', () => {
    // Retrying a TypeError would pay for the same bug once per model and then
    // report it as "provider down", turning a fixable defect into a mystery.
    const failure = classifyProviderFailure(new TypeError('x.y is not a function'));
    expect(failure.retryable).toBe(false);
    expect(failure.error).toContain('unexpected');
  });

  it('stops immediately when the time budget is spent', () => {
    const failure = classifyProviderFailure(new APIUserAbortError());
    expect(failure.retryable).toBe(false);
    expect(failure.error).toContain('budget');
  });
});

describe('redactSecrets', () => {
  it('strips keys from text that is about to be stored or displayed', () => {
    const leak = 'HTTP 401 {"error":"invalid key sk-or-v1-abcdef0123456789"}';
    const clean = redactSecrets(leak);

    expect(clean).not.toContain('sk-or-v1-abcdef0123456789');
    expect(clean).toContain('[redacted]');
  });

  it('strips keys from every supported provider', () => {
    // Each provider's key has a different shape, and a redaction list that
    // misses one turns an audit row into a credential leak.
    expect(redactSecrets('sk-or-v1-abcdef0123456789')).not.toContain('abcdef0123456789');
    expect(redactSecrets('nvapi-abcdef0123456789')).not.toContain('abcdef0123456789');
    expect(redactSecrets('sk-proj-abcdef0123456789')).not.toContain('abcdef0123456789');
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
    expect(redactSecrets('{"apiKey":"super-secret-value"}')).not.toContain('super-secret-value');
    expect(redactSecrets('api_key = hunter2hunter2')).not.toContain('hunter2hunter2');
  });

  it('leaves ordinary diagnostic text alone', () => {
    const text = 'HTTP 503: model is overloaded, try again';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('modelCandidates', () => {
  it('falls back to the provider default when no model is configured', () => {
    const env = testEnv({ AI_PROVIDER: 'groq', AI_MODEL: undefined, AI_FALLBACK_MODELS: '' });
    expect(modelCandidates(env)).toEqual(['llama-3.3-70b-versatile']);
  });

  it('de-duplicates the primary model against the fallback list', () => {
    const env = testEnv({
      AI_PROVIDER: 'groq',
      AI_MODEL: 'a',
      AI_FALLBACK_MODELS: 'a, b ,c',
    });
    expect(modelCandidates(env)).toEqual(['a', 'b', 'c']);
  });
});

describe('provider presets', () => {
  const cases = [
    { provider: 'groq', envVar: 'GROQ_API_KEY', host: 'api.groq.com' },
    { provider: 'nvidia', envVar: 'NVIDIA_API_KEY', host: 'integrate.api.nvidia.com' },
    { provider: 'openrouter', envVar: 'OPENROUTER_API_KEY', host: 'openrouter.ai' },
    { provider: 'openai', envVar: 'OPENAI_API_KEY', host: 'api.openai.com' },
    { provider: 'gemini', envVar: 'GEMINI_API_KEY', host: 'generativelanguage.googleapis.com' },
    { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com' },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.provider} names a key and a reachable host`, () => {
      const preset = presetFor(testCase.provider);

      expect(preset.apiKeyEnv).toBe(testCase.envVar);
      expect(preset.baseUrl).toContain(testCase.host);
      // A specific model, never a router: see the note in .env.example.
      expect(preset.defaultModel.length).toBeGreaterThan(0);
      expect(preset.defaultModel).not.toContain('/free');
    });
  }

  it('picks the adapter from the wire format, not from the name', () => {
    // The one thing a preset table gets wrong is assuming a new vendor is
    // another row. Anthropic does not serve /chat/completions, so it has to
    // reach a different adapter - a wrong `kind` here is a 404 on a URL that
    // looks correct, which is the hardest kind of 404 to diagnose.
    expect(presetFor('groq').kind).toBe('openai_compatible');
    expect(presetFor('gemini').kind).toBe('openai_compatible');
    expect(presetFor('anthropic').kind).toBe('anthropic');
    expect(presetFor('local').kind).toBe('local');
  });

  it('asks for JSON mode only where the provider has such a knob', () => {
    // Anthropic constrains output with a forced tool call instead, and a
    // `response_format` it does not recognise is a 400 rather than something it
    // quietly ignores.
    expect(presetFor('groq').jsonMode).toBe(true);
    expect(presetFor('anthropic').jsonMode).toBe(false);
  });

  it('needs no key only for the local matcher', () => {
    // The check behind the graceful-degradation test: `local` is the single
    // provider that authenticates to nothing, and it is the one case where an
    // absent key is correct rather than a misconfiguration.
    expect(presetFor('local').apiKeyEnv).toBeNull();
    expect(requiresApiKey('local')).toBe(false);
    expect(requiresApiKey('groq')).toBe(true);
    expect(requiresApiKey('anthropic')).toBe(true);
  });

  it('starts without the selected provider having a key', () => {
    // Rule 7, applied to configuration, and inverted deliberately. A missing key
    // used to be a boot failure so it could not surface as a 401 on the first
    // customer - but a service that will not start cannot queue that customer for
    // a person either. The report is now made through the health endpoint and
    // per request, and every affected request escalates.
    const saved = {
      provider: process.env.AI_PROVIDER,
      key: process.env.GROQ_API_KEY,
      universal: process.env.AI_API_KEY,
    };
    process.env.AI_PROVIDER = 'groq';
    delete process.env.GROQ_API_KEY;
    delete process.env.AI_API_KEY;

    try {
      const env = readEnv('.env.absent');

      expect(env.AI_PROVIDER).toBe('groq');
      // The universal name, which is the one an operator is told to set.
      expect(missingApiKeyFor(env)).toBe('AI_API_KEY is not set, so groq cannot be reached');
    } finally {
      restore('AI_PROVIDER', saved.provider);
      restore('GROQ_API_KEY', saved.key);
      restore('AI_API_KEY', saved.universal);
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('parseJson', () => {
  it('tolerates fences, prose and surrounding whitespace', () => {
    expect(parseJson('  {"a":1}  ')).toEqual({ a: 1 });
    expect(parseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJson('Here you go: {"a":3} - hope that helps')).toEqual({ a: 3 });
  });

  it('returns null rather than guessing', () => {
    expect(parseJson('not json at all')).toBeNull();
    expect(parseJson('')).toBeNull();
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('refuses to parse an unbounded body from a provider that ignores max_tokens', () => {
    // 200k of padding: the cap must stop the scan instead of the process.
    const huge = `{"a":1,"pad":"${'x'.repeat(200_000)}"}`;
    expect(parseJson(huge)).toBeNull();
  });
});

describe('toAnalyzerOrder', () => {
  const order: OrderRecord = {
    id: 'ORD-1',
    customerId: 'CUST-1',
    placedAt: new Date('2026-02-01T00:00:00.000Z'),
    deliveredAt: new Date('2026-02-05T00:00:00.000Z'),
    ageDays: 41,
    status: 'delivered',
    paymentState: 'settled',
    refundedCents: 0,
    totalCents: 12_345,
    isSubscription: false,
    trackingStatus: 'delivered',
    signedByCustomer: false,
    conditionAtDelivery: 'sealed',
    items: [
      {
        id: 'ITEM-1',
        name: 'Aurora Desk Lamp',
        unitPriceCents: 12_345,
        quantity: 1,
        finalSale: false,
        digital: false,
        downloaded: false,
      },
    ],
  };

  it('sends only the fields the prompt needs', () => {
    const flattened = toAnalyzerOrder(order);

    expect(flattened).not.toBeNull();
    expect(flattened?.totalCents).toBe(12_345);
    expect(flattened?.items[0]?.name).toBe('Aurora Desk Lamp');
    // Nothing else leaks: the prompt gets an order summary, not the CRM record,
    // so adding a column to the order table cannot widen what a provider sees.
    expect(Object.keys(flattened ?? {}).sort()).toEqual([
      'ageDays',
      'id',
      'items',
      'paymentState',
      'status',
      'totalCents',
    ]);
  });

  it('passes null through for an unresolvable order', () => {
    expect(toAnalyzerOrder(null)).toBeNull();
  });
});

describe('the extraction wire format', () => {
  it('strips anything the schema does not declare, so a model cannot smuggle fields in', () => {
    // A reasoning model may return a chain of thought, and a prompt-injected one
    // may return whatever it likes. The schema is the whole boundary: undeclared
    // keys are dropped, so nothing outside this list can reach the database, the
    // resolver or the admin drawer.
    const parsed = ExtractionOutputSchema.parse({
      intent: 'refund',
      reason: 'damaged',
      condition: 'damaged',
      confidence: 0.9,
      orderRef: null,
      claimedAmountCents: 100,
      items: [],
      evidenceQuotes: ['it is broken'],
      language: 'en',
      urgency: 'normal',
      policyOverrideAttempted: false,
      suggestedDecision: 'approved',
      suggestedAmountCents: 100,
      reasoning: 'private chain of thought',
      decision: 'approved',
    });

    expect(Object.keys(parsed).sort()).toEqual(
      [
        'claimedAmountCents',
        'condition',
        'confidence',
        'evidenceQuotes',
        'intent',
        'items',
        'language',
        'orderRef',
        'policyOverrideAttempted',
        'reason',
        'suggestedAmountCents',
        'suggestedDecision',
        'urgency',
      ].sort(),
    );
    expect(parsed).not.toHaveProperty('reasoning');
  });

  it('rejects a claim that names a reason outside the policy vocabulary', () => {
    const result = ExtractionOutputSchema.safeParse({
      intent: 'refund',
      reason: 'because_i_said_so',
      condition: 'damaged',
      confidence: 0.9,
      orderRef: null,
      claimedAmountCents: null,
      items: [],
      evidenceQuotes: [],
      language: 'en',
      urgency: 'normal',
      policyOverrideAttempted: false,
      suggestedDecision: 'approved',
      suggestedAmountCents: 0,
    });

    expect(result.success).toBe(false);
  });
});
