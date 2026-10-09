import type {
  BlockedItem,
  ClaimExtraction,
  GroundingResult,
  InjectionAction,
  InjectionScan,
  LineClaim,
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
import { sumPrices } from '../lib/money.js';

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
  /**
   * The lines the request is about, when the customer named them. Reason rules
   * read it to tell "a line the customer claimed but that has no grounded
   * reason" from a line they never mentioned. Optional because contexts built
   * by hand - tests, scripts - have no claim scope, which the rules treat as
   * "all the lines the extraction named".
   */
  readonly claimedItemIds?: readonly string[];
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

/**
 * The amount this request actually puts at risk, for the amount-authority
 * thresholds (R-03, R-15): the sum of the lines the customer pointed at, so a
 * $12 mug claim on a $700 order is not force-escalated alongside a whole-order
 * repayment.
 *
 * null when the claim has no named lines - a whole-order claim has no scope to
 * narrow against, and callers fall back to the order total, which is what keeps
 * §4.1/§6.5 holding for whole-order claims. Named lines that resolve to nothing
 * also fall back, so a bogus pick cannot dodge the threshold either.
 */
export function disputedClaimCents(context: PolicyContext): number | null {
  const order = context.order;
  const claimed = context.claimedItemIds;
  if (order === null || claimed === undefined || claimed.length === 0) {
    return null;
  }
  const wanted = new Set(claimed);
  const matched = order.items.filter((item) => wanted.has(item.id));
  if (matched.length === 0) {
    return null;
  }
  return sumPrices(matched.map((item) => item.unitPriceCents * item.quantity));
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

/**
 * The claimed lines for a per-line reading.
 *
 * The customer's own `claimedItemIds` when they named lines; otherwise the
 * lines the extraction itself named. The two are deliberately not merged:
 * a line the customer ticked but the model never mentioned must still be
 * reviewable, but a line the model named that the customer never claimed
 * cannot be.
 */
export function claimedLineIds(context: PolicyContext): readonly string[] {
  const claims = context.extraction?.lineClaims ?? [];
  if (context.claimedItemIds !== undefined && context.claimedItemIds.length > 0) {
    return context.claimedItemIds;
  }
  return claims.map((claim) => claim.itemId);
}

/**
 * The claimed lines whose per-line reason is grounded and faulty.
 *
 * One truth for both reason rules: R-04 approves exactly these lines, and R-12
 * escalates the claimed lines that are not in the set. Sharing the set keeps
 * the two from disagreeing about which line the model stood behind - a
 * disagreement is how a grounded line and an ungrounded one both get the
 * wrong outcome.
 *
 * Undefined when the extraction carried no `lineClaims`: there is no per-line
 * reading to split on, and callers fall back to the whole-message behaviour.
 */
export function groundedClaimLineIds(context: PolicyContext): string[] | undefined {
  const claims = context.extraction?.lineClaims;
  const lines = context.grounding?.lines;
  if (claims === undefined || claims.length === 0 || lines === undefined || lines.length === 0) {
    return undefined;
  }
  const grounding = new Map(lines.map((line) => [line.itemId, line.grounded]));
  const byId = new Map(claims.map((claim) => [claim.itemId, claim]));
  const eligible = new Set(context.eligibleItems.map((item) => item.id));
  const result: string[] = [];
  for (const itemId of claimedLineIds(context)) {
    if (lineClaimGrounded(byId.get(itemId), grounding.get(itemId), eligible.has(itemId))) {
      result.push(itemId);
    }
  }
  return result;
}

function lineClaimGrounded(
  claim: LineClaim | undefined,
  grounded: boolean | undefined,
  eligible: boolean,
): boolean {
  return (
    claim !== undefined &&
    grounded === true &&
    FAULTY_REASONS.includes(claim.reason) &&
    eligible
  );
}
