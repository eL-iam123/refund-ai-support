import { ALLOWED_OUTCOMES, type RuleEvaluation, type RuleOutcome } from '@refund/shared';

/**
 * Domain invariants (coding standard: use assertions).
 *
 * These are not "should never happen" checks - each one protects a specific
 * business or security property, and a violation means a customer could be
 * wrongly refused or wrongly paid. They throw PolicyInvariantError so the API
 * returns a 500 rather than quietly doing the wrong thing.
 */

export class PolicyInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyInvariantError';
  }
}

export function assertDomain(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new PolicyInvariantError(message);
  }
}

/**
 * Guards the rule-class contract: a risk signal may escalate to a human but may
 * never deny. Denying on a risk signal is an unjust refusal of a valid claim,
 * so this is enforced from the ALLOWED_OUTCOMES table rather than trusted to
 * whoever writes the next rule.
 */
export function assertOutcomeAllowed(evaluation: RuleEvaluation): void {
  const allowed: readonly RuleOutcome[] = ALLOWED_OUTCOMES[evaluation.ruleClass];
  assertDomain(
    allowed.includes(evaluation.outcome),
    `rule ${evaluation.ruleId} (class ${evaluation.ruleClass}) produced "${evaluation.outcome}", ` +
      `which its class forbids. Permitted: ${allowed.join(', ')}.`,
  );
}

export function assertEvaluationsAllowed(evaluations: readonly RuleEvaluation[]): void {
  for (const evaluation of evaluations) {
    assertOutcomeAllowed(evaluation);
  }
}

/** Rule 5/10: the money-side invariants. */
export function assertAmountSane(amountCents: number, orderTotalCents: number | null): void {
  assertDomain(Number.isInteger(amountCents), `refund amount must be whole cents, got ${amountCents}`);
  assertDomain(amountCents >= 0, `refund amount must not be negative, got ${amountCents}`);
  if (orderTotalCents !== null) {
    assertDomain(
      amountCents <= orderTotalCents,
      `refund amount ${amountCents} exceeds order total ${orderTotalCents}`,
    );
  }
}
