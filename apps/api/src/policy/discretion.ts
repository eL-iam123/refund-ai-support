import type { ClaimExtraction, Decision, GroundingResult, RuleEvaluation } from '@refund/shared';
import type { DiscretionConfig } from '../config/env.js';
import type { CustomerRecord, OrderRecord } from '../db/records.js';
import { FAULTY_REASONS } from '@refund/shared';

/**
 * The discretion layer: an automatic, rule-governed equivalent of the human
 * override.
 *
 * A human assistant does not apply a rulebook mechanically. A good customer a few
 * days past the window, a loyal plus-member with a faulty toaster, a customer whose
 * message is messy but clearly means "it arrived broken" - a person resolves these
 * on the spot and explains why. The base policy cannot: it either refuses on a
 * technicality or escalates, and both read as "the computer does not care".
 *
 * This module is that judgement, encoded as deterministic rules rather than left
 * to the model. It is the same trade a human override makes, made in advance and
 * within pre-authorised bounds:
 *
 *  - It only ever softens an **escalation**. A denial is a denial; only a person
 *    can overturn one (see `overrideGuard.ts`). Discretion never touches it.
 *  - It is **deterministic and configurable**. The same order, customer and
 *    message always produce the same recommendation, and every bound is an
 *    operator-controlled environment variable.
 *  - It is **auditable**. The resolver records each adjustment as an
 *    `OverrideRecord`, so a reviewer sees the policy outcome *and* the discretion
 *    that softened it - the same visibility a manual override has.
 *  - The **model is not involved**. `recommendDiscretion` is a pure function of
 *    order facts, the extraction and the config. AAI 0001 is untouched: the
 *    resolver remains the sole writer of the decision, and the model's proposal
 *    is still inert data.
 *
 * The rules are ordered. The first that fires wins, so the most specific,
 * most defensible resolution is the one applied.
 */

export type DiscretionRecommendation =
  | { readonly kind: 'none' }
  | { readonly kind: 'approve' }
  | { readonly kind: 'partial_refund'; readonly amountCents: number }
  | { readonly kind: 'exchange' }
  | { readonly kind: 'store_credit' };

export interface DiscretionContext {
  /** The base policy's decision. Discretion is only consulted when this is `escalated`. */
  readonly baseDecision: Decision;
  /** The rule that produced the escalation, when one did. */
  readonly winner: RuleEvaluation | null;
  /** Every evaluation in the trace, for reading which rules escalated. */
  readonly trace: readonly RuleEvaluation[];
  readonly order: OrderRecord | null;
  readonly customer: CustomerRecord | null;
  readonly eligibleAmountCents: number;
  readonly orderTotalCents: number;
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  readonly config: DiscretionConfig;
}

/** The rule ids that escalated, for reading *why* the request landed with a person. */
function escalatedRuleIds(trace: readonly RuleEvaluation[]): Set<string> {
  return new Set(trace.filter((evaluation) => evaluation.outcome === 'escalate').map((evaluation) => evaluation.ruleId));
}

/** A refund claim the customer's own words support, in one of the qualifying reasons. */
function hasGroundedFault(extraction: ClaimExtraction | null, grounding: GroundingResult | null): boolean {
  if (extraction === null || grounding === null || !grounding.grounded) {
    return false;
  }
  return extraction.intent === 'refund' && FAULTY_REASONS.includes(extraction.reason);
}

/** A plausible claim that is not a qualifying fault - the customer has a problem, just not a refundable one. */
function hasPlausibleNonFaultClaim(extraction: ClaimExtraction | null): boolean {
  if (extraction === null) {
    return false;
  }
  return extraction.intent === 'refund' && extraction.reason !== 'none' && extraction.reason !== 'other';
}

/**
 * How close a rejected quote is to the customer's own words, as a similarity in
 * [0, 1]. Used only by the near-miss rule, which is off by default: grounding is
 * the guarantee that the model cannot fabricate a claim, and this is the one place
 * that guarantee is relaxed, so it is opt-in and bounded to low-risk claims.
 *
 * Compares word sets rather than characters, so a model that smoothed a
 * paraphrase ("the mug was delivered cracked" for "the mug arrived cracked") still
 * matches, while a quote about an entirely different subject does not.
 */
function quoteSimilarity(quote: string, corpus: readonly string[]): number {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((word) => word.length > 2),
    );
  const target = words(quote);
  if (target.size === 0) {
    return 0;
  }
  let best = 0;
  for (const message of corpus) {
    const source = words(message);
    if (source.size === 0) {
      continue;
    }
    let shared = 0;
    for (const word of target) {
      if (source.has(word)) {
        shared += 1;
      }
    }
    const score = shared / target.size;
    if (score > best) {
      best = score;
    }
  }
  return best;
}

/**
 * The customer's own words, for the near-miss quote check. The current message is
 * not in the context, so the corpus is the rejected quotes themselves plus any
 * verified ones - enough to recognise a near-miss without the full transcript.
 */
function nearMissSimilarity(grounding: GroundingResult | null): number {
  if (grounding === null) {
    return 0;
  }
  const corpus = [...grounding.verifiedQuotes, ...grounding.rejectedQuotes];
  if (corpus.length === 0) {
    return 0;
  }
  let best = 0;
  for (const quote of grounding.rejectedQuotes) {
    best = Math.max(best, quoteSimilarity(quote, corpus));
  }
  return best;
}

/**
 * The safe, off-by-default configuration.
 *
 * Exported so the resolver can default to it when a caller does not supply one,
 * and so tests that do not care about discretion get the behaviour they always
 * had. Every bound is inert until an operator opts in.
 */
export const DEFAULT_DISCRETION: DiscretionConfig = {
  enabled: false,
  maxAmountCents: 50_000,
  loyaltyMaxAmountCents: 150_000,
  maxAgeDays: 45,
  allowPartial: false,
  allowExchange: false,
  allowStoreCredit: false,
  minConfidence: 0.5,
  nearMissQuote: false,
};

/** The recommendation kinds that carry a decision, i.e. everything except `none`. */
export type DecisionKind = Exclude<DiscretionRecommendation['kind'], 'none'>;

/**
 * Map a discretion recommendation to the decision it produces.
 *
 * `approve` is the recommendation's word; the decision is `approved`. The other
 * kinds are already decision values.
 */
export function decisionFromRecommendation(kind: DecisionKind): Decision {
  if (kind === 'approve') {
    return 'approved';
  }
  return kind;
}

/** What every discretion rule needs, derived once from the context. */
interface RuleInput {
  readonly escalated: ReadonlySet<string>;
  readonly grounded: boolean;
  readonly loyal: boolean;
  readonly plausibleNonFault: boolean;
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  readonly eligibleAmountCents: number;
  readonly orderAgeDays: number;
  readonly config: DiscretionConfig;
}

/** 1. Courtesy window: a good customer a few days past the window with a grounded fault. */
function courtesyWindow(input: RuleInput): DiscretionRecommendation {
  if (input.escalated.has('R-01b') && input.orderAgeDays <= input.config.maxAgeDays && input.grounded) {
    return { kind: 'approve' };
  }
  return { kind: 'none' };
}

/** 2. Loyalty: a plus/enterprise member with a qualifying fault, within the higher cap. */
function loyalty(input: RuleInput): DiscretionRecommendation {
  if (input.loyal && input.grounded && input.eligibleAmountCents <= input.config.loyaltyMaxAmountCents) {
    return { kind: 'approve' };
  }
  return { kind: 'none' };
}

/** 3. Low-value auto-approve: a small, clearly-faulted claim a human resolves at once. */
function lowValueApprove(input: RuleInput): DiscretionRecommendation {
  if (input.grounded && input.eligibleAmountCents <= input.config.maxAmountCents) {
    return { kind: 'approve' };
  }
  return { kind: 'none' };
}

/** 4. Partial refund: a genuine fault on a claim larger than the pre-authorised amount. */
function partialRefund(input: RuleInput): DiscretionRecommendation {
  if (input.grounded && input.config.allowPartial && input.eligibleAmountCents > input.config.maxAmountCents) {
    return { kind: 'partial_refund', amountCents: input.config.maxAmountCents };
  }
  return { kind: 'none' };
}

/** 5. Exchange / store credit: a plausible claim that is not a refundable fault. */
function alternative(input: RuleInput): DiscretionRecommendation {
  if (!input.plausibleNonFault) {
    return { kind: 'none' };
  }
  if (input.config.allowExchange) {
    return { kind: 'exchange' };
  }
  if (input.config.allowStoreCredit) {
    return { kind: 'store_credit' };
  }
  return { kind: 'none' };
}

/**
 * 6. Near-miss quote: the model understood the claim but smoothed the wording, so the
 * verbatim check rejected it. Off by default, because this is the one place the
 * grounding guarantee is relaxed.
 */
function nearMissQuote(input: RuleInput): DiscretionRecommendation {
  const { extraction, grounding, eligibleAmountCents, config } = input;
  if (
    config.nearMissQuote &&
    extraction !== null &&
    grounding !== null &&
    !grounding.grounded &&
    nearMissSimilarity(grounding) >= 0.6 &&
    extraction.confidence >= config.minConfidence &&
    eligibleAmountCents <= config.maxAmountCents
  ) {
    return { kind: 'partial_refund', amountCents: Math.min(eligibleAmountCents, config.maxAmountCents) };
  }
  return { kind: 'none' };
}

/** The rules in priority order. The first that fires wins. */
const RULES: readonly ((input: RuleInput) => DiscretionRecommendation)[] = [
  courtesyWindow,
  loyalty,
  lowValueApprove,
  partialRefund,
  alternative,
  nearMissQuote,
];

/**
 * Decide whether an escalation should be softened, and to what.
 *
 * Returns `none` when the layer is disabled, when the base decision is not an
 * escalation, or when no rule's pre-authorised bounds cover the case. `none`
 * means "the escalation stands", which is the safe default.
 */
export function recommendDiscretion(context: DiscretionContext): DiscretionRecommendation {
  const { config, baseDecision, trace, order, customer, eligibleAmountCents, extraction, grounding } = context;

  if (!config.enabled || baseDecision !== 'escalated') {
    return { kind: 'none' };
  }
  if (order === null || eligibleAmountCents <= 0) {
    return { kind: 'none' };
  }

  const input: RuleInput = {
    escalated: escalatedRuleIds(trace),
    grounded: hasGroundedFault(extraction, grounding),
    loyal: customer !== null && customer.tier !== 'standard',
    plausibleNonFault: hasPlausibleNonFaultClaim(extraction),
    extraction,
    grounding,
    eligibleAmountCents,
    orderAgeDays: order.ageDays,
    config,
  };

  for (const rule of RULES) {
    const result = rule(input);
    if (result.kind !== 'none') {
      return result;
    }
  }
  return { kind: 'none' };
}
