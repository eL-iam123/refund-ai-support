import type { RefundDecision } from '@refund/shared';
import type { PhraseEnvelope } from '../ai/analyzer.js';
import type { OrderRecord } from '../db/records.js';
import { formatCents } from '../lib/money.js';
import { reasonFor } from './compose.js';

/**
 * The closed envelope a phrasing reply may state, and nothing else.
 *
 * Every field is derived from the resolver's decision and the order - never
 * from the customer's message and never from a model - so the set of facts a
 * reply can contain is fixed before any prose exists. The validator checks
 * the reply against exactly this object, which is what makes "the model
 * writes the words" compatible with "the engine owns the facts".
 */

/** Every rendering of an amount the reply may use. Both, because "$24" in one sentence and "$24.00" in the next reads as two figures. */
function allowedAmounts(cents: number): readonly string[] {
  if (cents <= 0) {
    return [];
  }
  const full = formatCents(cents);
  const short = full.replace(/\.00$/, '');
  return short === full ? [full] : [short, full];
}

/** Eligible line ids resolved to the names the customer saw at checkout. */
function itemNames(decision: RefundDecision, order: OrderRecord | null): readonly string[] {
  if (order === null || decision.eligibleItemIds.length === 0) {
    return [];
  }
  const names = new Map(order.items.map((item) => [item.id, item.name] as const));
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const id of decision.eligibleItemIds) {
    const name = names.get(id);
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      resolved.push(name);
    }
  }
  return resolved;
}

/**
 * What must appear verbatim: timing and next step, per outcome.
 *
 * A denial names the review path rather than a timeline, because there is no
 * payment coming; an escalation names the one-business-day wait the composer
 * already promises, so the two wordings can never disagree about it.
 *
 * An escalation additionally names *why*, in the deciding rule's own words:
 * a customer told only "a person will reply" cannot tell a routine handoff
 * from a fraud hold, and the generic sentence is what made escalations feel
 * robotic. The validator strips required sentences before checking rival
 * outcomes, so a reason that itself names a decision verb (R-03's "approve")
 * cannot trip the check.
 */
function mustSayFor(decision: RefundDecision): readonly string[] {
  switch (decision.decision) {
    case 'approved':
      return ['It will go back to your original payment method once a team member has checked it.'];
    case 'partial_refund':
      return ['Reply here if the details look wrong and a person will review it.'];
    case 'exchange':
    case 'store_credit':
      return ['A member of our team will confirm the details with you here.'];
    case 'denied':
      return ['Reply to this message and a person will review it.'];
    case 'escalated':
      return [
        `Because ${reasonFor(decision)}`,
        'A person will reply within one business day.',
        'Nothing further is needed from you.',
      ];
    default:
      return ['A person will reply within one business day.', 'Nothing further is needed from you.'];
  }
}

/** Builds the envelope for one decided outcome. Pure data, no prose. */
export function buildPhraseEnvelope(decision: RefundDecision, order: OrderRecord | null): PhraseEnvelope {
  return {
    outcome: decision.decision,
    amountCents: decision.refundAmountCents,
    allowedAmounts: allowedAmounts(decision.refundAmountCents),
    itemNames: itemNames(decision, order),
    reasonSummary: decision.summary,
    mustSay: mustSayFor(decision),
  };
}
