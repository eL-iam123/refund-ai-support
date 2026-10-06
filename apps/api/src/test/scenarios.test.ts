import { describe, expect, it } from 'vitest';
import { SCENARIOS, type Scenario } from '@refund/shared';
import { formatCents } from '../lib/money.js';
import { scenarioHarness } from './helpers.js';

/**
 * The conformance suite: 19 scenarios, each one an executable claim about the
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

  // A scenario may now *expect* the question - asking before escalating is the point -
  // and one that asks when it should have decided is still a softer failure than the
  // assertions below, so it is reported here with its own wording visible.
  if (scenario.expectsQuestion) {
    if (result.stage !== 'asked') {
      throw new Error(`${scenario.id} should have asked, but decided ${result.decision.decision}`);
    }
    return { ...result, extractionCalls: h.analyzerCalls() };
  }

  // A scenario may expect the remedy confirmation instead of a decision: a
  // payable claim with no money ask comes back as the confirmation question.
  // The marker is asserted rather than the full wording, because the wording
  // names the amount and the contract here is that it asked at all.
  if (scenario.expectsConfirmation) {
    if (result.stage !== 'asked') {
      throw new Error(`${scenario.id} should have confirmed, but decided ${result.decision.decision}`);
    }
    if (!result.question.includes('Before we refund anything:')) {
      throw new Error(`${scenario.id} asked, but not the confirmation: ${result.question}`);
    }
    return { ...result, extractionCalls: h.analyzerCalls() };
  }

  if (result.stage === 'asked') {
    throw new Error(`${scenario.id} did not decide: ${result.question}`);
  }
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

      const decided = result.stage === 'decided' ? result : null;

      if (scenario.expectsQuestion) {
        // The contract for these is the question itself: it must exist, it must be
        // the targeted one rather than a vague opener, and it must not have decided.
        // What happens after the answer is covered in `discretion.test.ts`, which can
        // supply the transcript this single-turn harness cannot.
        expect(result.stage, `${scenario.id} should have asked`).toBe('asked');
        if (result.stage === 'asked') {
          expect(result.question).toMatch(/what has gone wrong|which item|which order|condition/i);
          expect(result.question).not.toMatch(/tell me (a little )?more|anything else/i);
        }
        return;
      }

      if (scenario.expectsConfirmation) {
        // The contract is the confirmation and nothing else: the claim stated a
        // problem but no remedy, so the engine must ask rather than approve.
        expect(result.stage, `${scenario.id} should have confirmed`).toBe('asked');
        if (result.stage === 'asked') {
          expect(result.question).toContain('Before we refund anything:');
        }
        return;
      }

      if (decided === null) {
        const askedQuestion = result.stage === 'asked' ? result.question : '';
        throw new Error(`${scenario.id} asked instead of deciding: ${askedQuestion}`);
      }

      expect(
        `${decided.decision.decision} ${formatCents(decided.decision.refundAmountCents)}`,
      ).toBe(`${scenario.expectedDecision} ${formatCents(scenario.expectedAmountCents)}`);

      expect(decidedRules(decided.decision.trace)).toEqual([...scenario.expectedRules].sort());

      for (const supporting of scenario.expectedSupportingRules ?? []) {
        expect(decided.decision.trace.map((rule) => rule.ruleId)).toContain(supporting);
      }

      // The core claim: a fact-gate decision never involves a model.
      expect(result.llmCalled).toBe(scenario.expectsLlmCall);
      expect(result.extractionCalls).toBe(scenario.expectsLlmCall ? 1 : 0);

      expect(clamped(decided.decision.overrides.map((override) => override.code))).toBe(
        scenario.expectsClamp,
      );

      // Every decision must cite policy and carry a usable customer reply.
      expect(decided.decision.policyRef).toMatch(/REFUND_POLICY\.md/);
      const reply = decided.stage === 'decided' ? decided.responseText : '';
      expect(reply.length).toBeGreaterThan(20);
      if (scenario.expectedDecision === 'denied') {
        expect(decided.decision.refundAmountCents).toBe(0);
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

    // Asked scenarios have no decision to read, and pretending they do is what makes
    // a suite lie about its own coverage.
    const decided = new Set(
      results.flatMap((result) => (result.stage === 'decided' ? decidedRules(result.decision.trace) : [])),
    );
    expect(decided.size).toBeGreaterThanOrEqual(12);
  });

  it('never lets the model raise an amount above the order total', async () => {
    for (const scenario of SCENARIOS) {
      const result = await run(scenario);
      // A question pays nothing, so the bound only applies where there is a decision.
      if (result.stage === 'decided' && result.order !== null) {
        expect(result.decision.refundAmountCents).toBeLessThanOrEqual(result.order.totalCents);
      }
    }
  });
});
