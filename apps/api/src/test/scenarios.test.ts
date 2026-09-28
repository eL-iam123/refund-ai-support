import { describe, expect, it } from 'vitest';
import { SCENARIOS, type Scenario } from '@refund/shared';
import { formatCents } from '../lib/money.js';
import { scenarioHarness } from './helpers.js';

/**
 * The conformance suite: 18 scenarios, each one an executable claim about the
 * policy engine.
 *
 * Beyond the decision itself, every scenario asserts the two properties that
 * are easy to claim and hard to prove - whether the model was involved at all,
 * and whether the resolver had to clamp it. A rule is not implemented until a
 * scenario here says so.
 */

async function run(scenario: Scenario) {
  const h = scenarioHarness();
  const result = await h.run({
    requestId: `REQ-${scenario.id}`,
    customerId: scenario.customer.key,
    orderId: scenario.orderId,
    message: scenario.message,
  });
  return { ...result, extractionCalls: h.analyzerCalls() };
}

function decidedRules(trace: readonly { ruleId: string; outcome: string }[]): string[] {
  return trace
    .filter((evaluation) => evaluation.outcome !== 'pass')
    .map((evaluation) => evaluation.ruleId)
    .sort();
}

function clamped(codes: readonly string[]): boolean {
  return codes.some((code) => code.includes('clamped'));
}

describe.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
  '%s',
  (id, scenario) => {
    it(`${scenario.goal}`, async () => {
      const result = await run(scenario);

      expect(
        `${result.decision.decision} ${formatCents(result.decision.refundAmountCents)}`,
      ).toBe(`${scenario.expectedDecision} ${formatCents(scenario.expectedAmountCents)}`);

      expect(decidedRules(result.decision.trace)).toEqual([...scenario.expectedRules].sort());

      for (const supporting of scenario.expectedSupportingRules ?? []) {
        expect(result.decision.trace.map((rule) => rule.ruleId)).toContain(supporting);
      }

      // The core claim: a fact-gate decision never involves a model.
      expect(result.llmCalled).toBe(scenario.expectsLlmCall);
      expect(result.extractionCalls).toBe(scenario.expectsLlmCall ? 1 : 0);

      expect(clamped(result.decision.overrides.map((override) => override.code))).toBe(
        scenario.expectsClamp,
      );

      // Every decision must cite policy and carry a usable customer reply.
      expect(result.decision.policyRef).toMatch(/REFUND_POLICY\.md/);
      expect(result.responseText.length).toBeGreaterThan(20);
      if (scenario.expectedDecision === 'denied') {
        expect(result.decision.refundAmountCents).toBe(0);
      }
      expect(id).toBe(scenario.id);
    });
  },
);

describe('scenario suite as a whole', () => {
  it('covers every stage of the pipeline and every rule class', async () => {
    const results = await Promise.all(SCENARIOS.map((scenario) => run(scenario)));
    const stages = new Set(results.flatMap((result) => result.timings.map((t) => t.stage)));

    expect(stages).toContain('intake');
    expect(stages).toContain('retrieve');
    expect(stages).toContain('fact_gates');
    expect(stages).toContain('resolve');
    expect(stages).toContain('respond');

    const decided = new Set(results.flatMap((result) => decidedRules(result.decision.trace)));
    expect(decided.size).toBeGreaterThanOrEqual(12);
  });

  it('never lets the model raise an amount above the order total', async () => {
    for (const scenario of SCENARIOS) {
      const result = await run(scenario);
      if (result.order !== null) {
        expect(result.decision.refundAmountCents).toBeLessThanOrEqual(result.order.totalCents);
      }
    }
  });
});
