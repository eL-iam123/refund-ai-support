import type { BlockedItem, RuleEvaluation, RuleId } from '@refund/shared';
import type { OrderItemRecord } from '../db/records.js';
import { evaluateRule, precedenceFold } from './engine.js';
import { rulesForScope } from './rules/index.js';
import type { PolicyContext } from './types.js';
import { sumPrices } from '../lib/money.js';

export interface GateResult {
  readonly evaluations: readonly RuleEvaluation[];
  readonly eligibleItems: readonly OrderItemRecord[];
  readonly blockedItems: readonly BlockedItem[];
  readonly eligibleAmountCents: number;
  /** True when the facts alone decided the request and the model is not needed. */
  readonly terminal: boolean;
  readonly decidingRuleId: RuleId | null;
}

/** Item-affecting gate rules run first: the eligible amount depends on them. */
const ITEM_GATE_RULES = rulesForScope('item').filter((rule) => rule.stage === 'fact_gates');
const ORDER_GATE_RULES = rulesForScope('order').filter((rule) => rule.stage === 'fact_gates');

function collectBlocked(evaluations: readonly RuleEvaluation[]): Map<string, RuleEvaluation> {
  const blocked = new Map<string, RuleEvaluation>();
  for (const evaluation of evaluations) {
    if (evaluation.outcome !== 'deny') {
      continue;
    }
    for (const itemId of evaluation.itemIds) {
      blocked.set(itemId, evaluation);
    }
  }
  return blocked;
}

function toBlockedItems(
  order: PolicyContext['order'],
  blocked: Map<string, RuleEvaluation>,
): BlockedItem[] {
  if (order === null) {
    return [];
  }
  return order.items.flatMap((item) => {
    const evaluation = blocked.get(item.id);
    if (evaluation === undefined) {
      return [];
    }
    return [
      {
        itemId: item.id,
        name: item.name,
        priceCents: item.unitPriceCents * item.quantity,
        ruleId: evaluation.ruleId,
        reason: evaluation.evidence,
      },
    ];
  });
}

/**
 * Stage 3: fact gates.
 *
 * Everything here is computable from the database alone. When it produces a
 * terminal outcome the pipeline stops and the model is never called - which is
 * the security property the scenario suite asserts with `llmCalled === false`.
 */
export function runFactGates(
  context: PolicyContext,
  claimedItemIds: readonly string[] = [],
): GateResult {
  const itemEvaluations = ITEM_GATE_RULES.map((rule) => evaluateRule(rule, context));
  const blocked = collectBlocked(itemEvaluations);
  const blockedItems = toBlockedItems(context.order, blocked);

  const eligibleItems = (context.order?.items ?? []).filter((item) => !blocked.has(item.id));
  const eligibleAmountCents = sumPrices(
    eligibleItems.map((item) => item.unitPriceCents * item.quantity),
  );

  const gateContext: PolicyContext = {
    ...context,
    db: context.db,
    eligibleItems,
    blockedItems,
    eligibleAmountCents,
  };
  const orderEvaluations = ORDER_GATE_RULES.map((rule) => evaluateRule(rule, gateContext));
  const evaluations = [...itemEvaluations, ...orderEvaluations];

  return {
    evaluations,
    eligibleItems,
    blockedItems,
    eligibleAmountCents,
    ...decideTermination(evaluations, eligibleAmountCents, claimedItemIds),
  };
}

/**
 * An item-scoped deny is an adjustment, not a verdict: blocking one item out
 * of a mixed basket leaves the rest of the request alive (S-17). It only
 * terminates when nothing eligible is left.
 *
 * An order-scoped deny or escalate always terminates, even when an item denial
 * outranks it in the precedence fold. Without that, a $700 order with a single
 * final-sale line would fold to the item deny first and reach the model before
 * §4.1 could send it to a person.
 */
function decideTermination(
  evaluations: readonly RuleEvaluation[],
  eligibleAmountCents: number,
  claimedItemIds: readonly string[],
): { terminal: boolean; decidingRuleId: RuleId | null } {
  const orderWinner = precedenceFold(evaluations.filter((e) => e.scope === 'order'));
  if (orderWinner !== null && orderWinner.outcome === 'deny') {
    return { terminal: true, decidingRuleId: orderWinner.ruleId };
  }
  if (eligibleAmountCents === 0) {
    const blocked = precedenceFold(evaluations.filter((e) => e.outcome === 'deny'));
    if (blocked !== null) {
      return { terminal: true, decidingRuleId: blocked.ruleId };
    }
  }
  if (claimedItemIds.length > 0) {
    const blockedClaimRules = evaluations.filter(
      (evaluation) => evaluation.outcome === 'deny' &&
        claimedItemIds.some((itemId) => evaluation.itemIds.includes(itemId)),
    );
    const blockedClaimIds = new Set(blockedClaimRules.flatMap((evaluation) => evaluation.itemIds));
    if (claimedItemIds.every((itemId) => blockedClaimIds.has(itemId))) {
      const decidingItemRule = precedenceFold(blockedClaimRules);
      if (decidingItemRule !== null) {
        return { terminal: true, decidingRuleId: decidingItemRule.ruleId };
      }
    }
  }
  if (orderWinner !== null && orderWinner.outcome === 'escalate') {
    return { terminal: true, decidingRuleId: orderWinner.ruleId };
  }
  return { terminal: false, decidingRuleId: null };
}
