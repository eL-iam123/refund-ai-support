import type { OrderItemRecord, OrderRecord } from '../db/records.js';
import type { BlockedItem } from '@refund/shared';

/**
 * Deterministic floor for messages that ask about the refund policy rather
 * than describe a problem. A question about what the policy allows is not a
 * claim, so answering it must not file a request or hand the thread to a
 * person. Composed from the order and the fact gates alone - the model is
 * never consulted, exactly like the no-complaint floor.
 */

/**
 * Phrasing that reads as "tell me what your policy allows" for some item.
 *
 * Deliberately loose on the interrogative and on spelling - a customer will
 * type "what does yor polic say about that item" and it must still match. The
 * cue must stay about eligibility and rules only: a message that names an
 * action on the money ("can you refund it again?") is a claim, not a policy
 * question, and belongs to the pipeline.
 */
const POLICY_CUE =
  /\b(?:polic(?:y|ies)|refund rules?|return (?:policy|rules?)|refundable|qualif(?:y|ies)|eligible|covered by|terms for|what (?:does|do) .{0,40}(?:say|allow|cover))\b/i;

/** The message is asking for money or an action on the money, so it is a claim. */
const CASH_CUE =
  /\b(?:\$\d|money\b|refund(?:ed)? (?:me|it|this|that|us)|money back|cash back|payment\b|approve\b|authori[sz]e\b|pay(?: us)?\b|never reached|never arrived|didn'?t (?:arrive|reach)|not (?:arrive|arrived)|owed\b|balance\b|credit\b|replacement\b|exchange (?:it|this|that)\b|return (?:it|this|that)\b|want (?:a|my|the|some)?\s*(?:refund|money|replacement|return))\b/i;

/**
 * Signals that the message is really reporting a fault. A claim phrased as a
 * question ("can i refund the coat, it arrived torn") must keep flowing into
 * the pipeline, never be answered from this floor.
 */
const FAULT_CUE =
  /\b(?:broken|damaged|crack(?:ed)?|torn|ripped|defective|faulty|missing|wrong (?:item|colour|color|size|shade|one)|wrongly|not working|not work(?:s|ing)|stopped working|dead on arrival|never (?:received|came|got)|arriv(?:ed|ing)|delivered|shipped|leak(?:ed|ing)?|split|stained)\b/i;

export function isPolicyQuestion(message: string): boolean {
  return POLICY_CUE.test(message) && !CASH_CUE.test(message) && !FAULT_CUE.test(message);
}

/** Per-rule phrasing for an item the facts say cannot be refunded. */
const BLOCKED_PHRASES: Record<string, string> = {
  'R-02': "it's marked final sale, so it doesn't qualify for a refund under our policy",
  'R-05': "it's a digital item, and once delivered or consumed it doesn't qualify for a refund under our policy",
  'R-10': "it's a subscription, and our policy doesn't refund renewal charges on it",
};

const BLOCKED_SAYSO = "I can't start a refund or an exchange for it. Is there anything else I can help with?";
const ELIGIBLE_SAYSO =
  "If something is wrong with it, tell me what happened and I'll check exactly what the policy allows.";

/**
 * The deterministic answer for the item the customer is asking about.
 *
 * The item is the one already scoped by the conversation - either the pending
 * question's item or the order's single item. Returns null only when there is
 * no order to answer from; when the customer asks at the ambiguity point, the
 * floor asks back which item, still without filing anything.
 */
export function policyAnswerForOrder(
  order: OrderRecord | null,
  claimedItemIds: readonly string[],
  blockedItems: readonly BlockedItem[],
): string | null {
  if (order === null || order.items.length === 0) {
    return null;
  }
  const claimed = claimedItemIds.filter((id) => order.items.some((item) => item.id === id));
  let item: OrderItemRecord;
  if (claimed.length > 0) {
    const match = order.items.find((candidate) => candidate.id === claimed[0]);
    if (match === undefined) {
      return null;
    }
    item = match;
  } else if (order.items.length === 1) {
    const single = order.items[0];
    if (single === undefined) {
      return null;
    }
    item = single;
  } else {
    return 'Which item would you like to know about?';
  }
  const blocked = blockedItems.find((entry) => entry.itemId === item.id);
  if (blocked !== undefined) {
    const reason = BLOCKED_PHRASES[blocked.ruleId] ?? "it doesn't qualify for a refund under our policy";
    return `The ${item.name} - ${reason}. ${BLOCKED_SAYSO}`;
  }
  return `The ${item.name} does qualify under our refund policy. ${ELIGIBLE_SAYSO}`;
}