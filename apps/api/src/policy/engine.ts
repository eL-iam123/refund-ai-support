import { PRECEDENCE, type RuleEvaluation } from '@refund/shared';
import { assertEvaluationsAllowed } from '../lib/assert.js';
import type { PolicyContext, PolicyRule } from './types.js';

/** Evaluates one rule and immediately checks its class contract. */
export function evaluateRule(rule: PolicyRule, context: PolicyContext): RuleEvaluation {
  const result = rule.evaluate(context);
  assertEvaluationsAllowed([result]);
  return result;
}

export function evaluateRules(
  rules: readonly PolicyRule[],
  context: PolicyContext,
): RuleEvaluation[] {
  return rules.map((rule) => evaluateRule(rule, context));
}

/**
 * Precedence fold: DENY > ESCALATE > APPROVE > pass (REFUND_POLICY.md §9).
 * A single reduce, not a branching ladder.
 */
export function precedenceFold(
  evaluations: readonly RuleEvaluation[],
): RuleEvaluation | null {
  return evaluations.reduce<RuleEvaluation | null>((best, current) => {
    if (best === null) {
      return current;
    }
    return PRECEDENCE[current.outcome] > PRECEDENCE[best.outcome] ? current : best;
  }, null);
}

/** Rules that actually decided something, for the audit trail and assertions. */
export function nonPassRules(evaluations: readonly RuleEvaluation[]): RuleEvaluation[] {
  return evaluations.filter((evaluation) => evaluation.outcome !== 'pass');
}
