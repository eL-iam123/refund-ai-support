import type {
  BlockedItem,
  ClaimExtraction,
  GroundingResult,
  InjectionAction,
  InjectionScan,
  RuleClass,
  RuleEvaluation,
  RuleId,
  RuleOutcome,
  RuleScope,
  Stage,
} from '@refund/shared';
import { FAULTY_REASONS } from '@refund/shared';
import type { CustomerRecord, OrderItemRecord, OrderRecord } from '../db/records.js';
import type { Db } from '../db/connection.js';

/** Everything a rule is allowed to look at. Rules are pure functions of this. */
export interface PolicyContext {
  /**
   * Read-only access to the ledger, for rules that must know how much of an
   * order is already spoken for. Handed in rather than imported so that a rule
   * stays a function of its context and cannot quietly reach for the database
   * it was not given - the reason the context is the only way in.
   */
  readonly db: Db;
  readonly customer: CustomerRecord | null;
  readonly order: OrderRecord | null;
  /** Same-day, same-value sibling order. Feeds R-11. */
  readonly duplicateSibling: OrderRecord | null;
  readonly injection: InjectionScan;
  /**
   * What R-14 does when a signal fires: refuse, or hand to a human. Denying is
   * the default. Configured, not hard-coded, so an operator can trade a false
   * denial for a review queue without a code change - see REFUND_POLICY.md §7.1.
   */
  readonly injectionAction: InjectionAction;
  /** null until stage 4. Only reason-stage rules may read it. */
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  /** Set only while item-affecting rules are being evaluated. */
  readonly subjectItem: OrderItemRecord | null;
  readonly eligibleItems: readonly OrderItemRecord[];
  readonly blockedItems: readonly BlockedItem[];
  readonly eligibleAmountCents: number;
  readonly orderTotalCents: number;
  /**
   * The order-total ceiling above which R-15 escalates. Supplied by the
   * orchestrator so the rule stays a pure function of its context.
   *
   * Optional so contexts built by hand - tests, scripts - keep working: absent
   * means the schema default, and a ceiling can only ever escalate, so omitting
   * it cannot widen what is paid.
   */
  readonly escalationCeilingCents?: number;
}

export interface PolicyRule {
  readonly id: RuleId;
  readonly title: string;
  readonly ruleClass: RuleClass;
  /**
   * `item` outcomes adjust the eligible set and never terminate a request on
   * their own. `order` outcomes can terminate. See policy/gates.ts.
   */
  readonly scope: RuleScope;
  readonly stage: Stage;
  readonly policyRef: string;
  readonly summary: string;
  evaluate(context: PolicyContext): RuleEvaluation;
}

export interface RuleSeed {
  readonly id: RuleId;
  readonly ruleClass: RuleClass;
  readonly scope: RuleScope;
  readonly policyRef: string;
  readonly outcome: RuleOutcome;
  readonly evidence: string;
  readonly itemIds?: readonly string[];
}

/** Builds an evaluation. Keeps every rule file to a handful of lines. */
export function evaluation(seed: RuleSeed): RuleEvaluation {
  return {
    ruleId: seed.id,
    ruleClass: seed.ruleClass,
    scope: seed.scope,
    outcome: seed.outcome,
    evidence: seed.evidence,
    policyRef: seed.policyRef,
    itemIds: seed.itemIds ?? [],
  };
}

export function pass(rule: PolicyRule, evidence: string): RuleEvaluation {
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: rule.scope,
    policyRef: rule.policyRef,
    outcome: 'pass',
    evidence,
  });
}

export function deny(rule: PolicyRule, evidence: string, itemIds: readonly string[] = []): RuleEvaluation {
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: rule.scope,
    policyRef: rule.policyRef,
    outcome: 'deny',
    evidence,
    itemIds,
  });
}

export function escalate(rule: PolicyRule, evidence: string): RuleEvaluation {
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: rule.scope,
    policyRef: rule.policyRef,
    outcome: 'escalate',
    evidence,
  });
}

export function approve(rule: PolicyRule, evidence: string): RuleEvaluation {
  return evaluation({
    id: rule.id,
    ruleClass: rule.ruleClass,
    scope: rule.scope,
    policyRef: rule.policyRef,
    outcome: 'approve',
    evidence,
  });
}

/** True when the claim is grounded in the customer's own words. */
export function hasGroundedFault(context: PolicyContext): boolean {
  const { extraction, grounding } = context;
  if (extraction === null || grounding === null || !grounding.grounded) {
    return false;
  }
  return (
    extraction.intent === 'refund' &&
    FAULTY_REASONS.includes(extraction.reason)
  );
}
