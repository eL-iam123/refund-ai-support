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
export function runFactGates(context: PolicyContext): GateResult {
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
    ...decideTermination(precedenceFold(evaluations), eligibleAmountCents),
  };
}

/**
 * An item-scoped deny is an adjustment, not a verdict: blocking one item out
 * of a mixed basket leaves the rest of the request alive (S-17). It only
 * terminates when nothing eligible is left.
 */
function decideTermination(
  winner: RuleEvaluation | null,
  eligibleAmountCents: number,
): { terminal: boolean; decidingRuleId: RuleId | null } {
  if (winner === null || winner.outcome === 'pass' || winner.outcome === 'approve') {
    return { terminal: false, decidingRuleId: null };
  }
  if (winner.outcome === 'deny' && winner.scope === 'item' && eligibleAmountCents > 0) {
    return { terminal: false, decidingRuleId: null };
  }
  return { terminal: true, decidingRuleId: winner.ruleId };
}
