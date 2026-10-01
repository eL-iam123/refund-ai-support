import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyzer } from '../ai/index.js';
import { AiUnavailableError, type AIAnalyzer, type ProviderAttempt } from '../ai/analyzer.js';
import { readEnv, type Env } from '../config/env.js';
import { processRefundRequest, type ProcessResult } from '../orchestrator.js';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { scenario, TEST_NOW } from './helpers.js';

/**
 * What the server does about a model it cannot reach.
 *
 * The interesting behaviour is not that a missing key is reported - it is that
 * the product keeps working while it is missing. That is only true because "no
 * usable claim" is already a decision path the resolver handles, and where the
 * absence of a claim can only escalate. This file pins that, because it is the
 * kind of property that breaks silently the first time somebody adds an
 * "if there is no extraction, assume the claim is benign" branch somewhere.
 */

/**
 * Reads a real env from a real file, with the ambient environment cleared first.
 *
 * The clearing is the point. `readEnv` gives the real environment precedence over
 * the file - correctly, since that is how a container is configured - so a test
 * that only writes a file is reading whatever keys the machine running the suite
 * happens to have. That produced a live HTTP call to Groq from a unit test, and
 * on a machine with no key it would instead have produced a confusing assertion
 * failure about an unconfigured provider.
 */
const MANAGED_KEYS = [
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_REQUIRED',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_FALLBACK_MODELS',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NODE_ENV',
  'ADMIN_API_SECRET',
] as const;

function envWith(overrides: Record<string, string>): Env {
  const path = join(mkdtempSync(join(tmpdir(), 'analyzer-factory-')), '.env');
  writeFileSync(
    path,
    Object.entries({ ADMIN_API_SECRET: 'a'.repeat(48), ...overrides })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );

  const saved = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_KEYS) {
    delete process.env[key];
  }
  try {
    return readEnv(path);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('choosing an analyzer', () => {
  it('does not select the heuristic analyzer when no provider or key is configured', () => {
    const analyzer = createAnalyzer(envWith({}));

    expect(analyzer.label).toBe('unconfigured');
    expect(analyzer.available).toBe(false);
    expect(analyzer.unavailableReason).toMatch(/AI_API_KEY is not set/);
  });

  it('builds the OpenAI-compatible client for the providers that expose one', () => {
    // Groq, OpenRouter, OpenAI, NVIDIA and Google all serve the same
    // chat-completions shape, so they are configuration rather than subclasses.
    // Gemini is the interesting one to pin: it is a *different vendor* reached
    // through the same adapter, which is the claim being made by putting it here.
    for (const [provider, key] of [
      ['groq', 'GROQ_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['nvidia', 'NVIDIA_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
    ] as const) {
      const env = envWith({ AI_PROVIDER: provider, [key]: 'k'.repeat(24) });

      expect(createAnalyzer(env)).toMatchObject({ label: provider });
    }
  });

  it('gives Anthropic its own adapter rather than pointing the OpenAI client at it', () => {
    // api.anthropic.com does not serve /chat/completions. Reusing the OpenAI
    // client would produce a 404 on a URL that is not wrong so much as
    // inoffensive, and a 404 reads to everyone as an invalid key.
    const env = envWith({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k'.repeat(24) });
    const analyzer = createAnalyzer(env);

    expect(analyzer.label).toBe('anthropic');
    expect(analyzer).toBeInstanceOf(Object);
    expect(analyzer).not.toHaveProperty('client');
  });

  it('uses the heuristic matcher when the provider is local', () => {
    const analyzer = createAnalyzer(envWith({ AI_PROVIDER: 'local' }));

    expect(analyzer.label).toBe('local (heuristic)');
  });

  it('authenticates any provider with the one universal key', () => {
    // The shortcut the whole configuration is built around: a key on its own is
    // enough, and the provider is worked out from it. Asserted per provider
    // because each of these reaches a different endpoint.
    for (const [key, expected] of [
      ['gsk_abc', 'groq'],
      ['nvapi-abc', 'nvidia'],
      ['AIzaAbc', 'gemini'],
      ['sk-or-v1-abc', 'openrouter'],
      ['sk-abc', 'openai'],
      ['sk-ant-abc', 'anthropic'],
    ] as const) {
      const analyzer = createAnalyzer(envWith({ AI_API_KEY: key }));
      expect(analyzer.label, key).toBe(expected);
    }
  });

  it('builds an unavailable analyzer when the key is missing, rather than throwing', () => {
    const analyzer = createAnalyzer(envWith({ AI_PROVIDER: 'groq' }));

    expect(analyzer.label).toBe('unconfigured');
    // The operator's only clue, in `/api/health` and on every stored decision, is
    // this string. "none" tells them a model is not answering; the name of the
    // variable tells them what to set.
    // The universal name, not the provider's: it is the one an operator is
    // expected to reach for, and it is the same for every provider.
    expect(analyzer.model).toBe('AI_API_KEY missing');
  });

  it('still reads claims when a key is present', () => {
    // The counterpart to the test above, so the degraded path cannot pass just
    // because every analyzer in the suite reports itself unavailable.
    const analyzer = createAnalyzer(envWith({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k'.repeat(24) }));

    expect(analyzer.label).toBe('groq');
  });
});

describe('a missing key', () => {
  it('reports itself unavailable through the normal provider-failure path', async () => {
    const analyzer = createAnalyzer(envWith({ AI_PROVIDER: 'groq' }));
    const attempts: ProviderAttempt[] = [];

    await expect(analyzer.analyze({ message: 'my television is broken', order: null, history: [] }, (a) => attempts.push(a))).rejects.toBeInstanceOf(
      AiUnavailableError,
    );

    // The reason is recorded per request rather than logged once at boot, so the
    // audit trail of a decision says why it had no evidence.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.error).toMatch(/AI_API_KEY is not set/);
    expect(attempts[0]?.ok).toBe(false);
  });
});

/**
 * The property that makes allowing a missing key safe: a product with no model
 * still answers, and answers conservatively.
 *
 * It is worth a real pipeline run rather than a unit test of the analyzer,
 * because the guarantee is not in the analyzer. It is that `NO_ANALYSIS` is a
 * state the resolver already handles, and this is the only place that is
 * observable.
 */
describe('the pipeline with no model configured', () => {
  const DAMAGED_TV = 'My NOVA 43 inch television arrived cracked and unusable.';

  function run(analyzer: AIAnalyzer): Promise<Extract<ProcessResult, { stage: 'decided' }>> {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    const s = scenario('S-01');
    const order = s.orders[0];
    if (order === undefined) {
      throw new Error('S-01 has no order to claim against');
    }
    return processRefundRequest(
      db,
      { analyzer, recordAttempt: () => undefined, injectionAction: 'deny' },
      {
        requestId: `REQ-${analyzer.label}`,
        customerId: s.customer.key,
        orderId: order.key,
        message: DAMAGED_TV,
        now: TEST_NOW,
      },
    ).then((result) => {
      if (result.stage === 'asked') {
        throw new Error(`pipeline asked instead of deciding: ${result.question}`);
      }
      return result;
    });
  }

  it('still answers, and escalates rather than approving on no evidence', async () => {
    const result = await run(createAnalyzer(envWith({ AI_PROVIDER: 'groq' })));

    // The claim is absent, so the model had no influence at all - and the reason
    // rules that need one cannot reach a conclusion. S-01 approves on a damaged
    // television, so this is the case where an extractor that guessed wrong would
    // pay real money.
    expect(result.extraction).toBeNull();
    expect(result.decision.decision).toBe('escalated');
    expect(result.responseText.length).toBeGreaterThan(0);
  });

  it('reaches the same verdict as a deliberately unavailable provider', async () => {
    // Two very different causes - no credentials at all, and a provider that is
    // configured and failing - must be indistinguishable to the policy. If they
    // were not, "the model was down" would be a way to get a different answer.
    const unconfigured = await run(createAnalyzer(envWith({ AI_PROVIDER: 'groq' })));
    const rateLimited = await run(FakeAnalyzer({ kind: 'unavailable', message: 'rate limited' }));

    expect(rateLimited.decision.decision).toBe('escalated');
    expect(rateLimited.decision.decision).toBe(unconfigured.decision.decision);
    // The same rules fired, in the same order, for the same reasons. A degradation
    // that reached a different rule would be a different decision wearing the
    // same label.
    expect(rateLimited.decision.trace.map((rule) => rule.ruleId)).toEqual(
      unconfigured.decision.trace.map((rule) => rule.ruleId),
    );
  });

  it('still approves when a model is available, so the test above is not vacuous', async () => {
    // The counterpart. Without this, "the no-model path escalates" would also be
    // satisfied by a broken pipeline that escalates everything, which would make
    // the graceful-degradation property look true for the wrong reason.
    const result = await run(createAnalyzer(envWith({ AI_PROVIDER: 'local' })));

    expect(result.extraction).not.toBeNull();
    expect(result.decision.decision).toBe('approved');
  });
});
