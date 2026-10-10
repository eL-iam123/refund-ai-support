import type { RefundDecision, RuleEvaluation } from '@refund/shared';
import type { OrderRecord } from '../db/records.js';
import { formatCents } from '../lib/money.js';
import { acknowledgementFor } from './acknowledge.js';
import { asksForSwap } from './intent.js';

/**
 * The reply that always exists, with or without a model.
 *
 * Response generation is the one stage allowed to be optional, because a
 * missing explanation is recoverable in a way a missing decision is not. This
 * composer therefore runs first and unconditionally; the model, when
 * available, only rewrites this text. If the call fails, times out or returns
 * something unusable, the customer still gets a correct, complete answer.
 *
 * It is also the safety net for prompt injection: the wording is assembled
 * from the decision and the order, never from the customer's message, so no
 * instruction embedded in that message can reach the customer-facing text.
 */
/**
 * What the order already has coming, when a denial is really about the balance.
 *
 * A denial because nothing remains to refund, on an order that already has a
 * refund pending or paid, is a confusing thing to send on its own: the customer
 * reads "we cannot refund this order" and concludes the pending refund was
 * refused. It was not - it is still there, and saying so is the difference
 * between one confusing message and two that contradict each other.
 */
function outstandingFor(decision: RefundDecision): string {
  if (decision.outstandingAmountCents <= 0) {
    return '';
  }
  return `${outstandingSentence(decision.outstandingState, decision.outstandingAmountCents)} `;
}

/**
 * Each state gets a whole sentence, not a phrase dropped into a fixed frame.
 * Assembling "A refund of $X" plus a verb produced "A refund of $100.00 has
 * already been refunded" - two claims of the same fact, which is the kind of
 * sentence that makes a customer re-read it.
 */
function outstandingSentence(
  state: RefundDecision['outstandingState'],
  cents: number,
): string {
  const amount = formatCents(cents);
  switch (state) {
    case 'pending':
      return `A refund of ${amount} is approved for this order and is waiting to be checked.`;
    case 'settled':
      return `${amount} of this order has already been refunded.`;
    case 'mixed':
      return `A refund of ${amount} on this order is already being processed.`;
    default:
      return '';
  }
}

/**
 * True when a rule refused the *whole order*, rather than excluding lines from it.
 *
 * The `excluded` sentence names the items the policy removed from the eligible
 * set - and that is the reason for the answer only when the refusal is about
 * those items. An order-scoped denial has its own reason (a subscription, a
 * chargeback, an unreadable request), and listing whatever item rules happened
 * to also exclude - a final-sale coat, say - reads as the reason it was refused.
 * A customer told their coat is why they were refused, when the real reason was
 * a subscription line elsewhere on the order, has been given the wrong answer.
 *
 * Order-scoped denials outrank item-scoped ones, so the presence of any
 * order-scoped deny in the trace means the refusal was not the items' doing.
 */
function refusedWholeOrder(decision: RefundDecision): boolean {
  return decision.trace.some((rule) => rule.scope === 'order' && rule.outcome === 'deny');
}

/**
 * What a partial refund left behind, named or not.
 *
 * Where an approval can name the blocked lines ("NAME is not eligible..."), a
 * partial refund is the same situation plus the money being sent, so the
 * sentence must say which lines are excluded and why, rather than trailing a
 * vague "the rest is not refundable" over what might be a very informative line.
 *
 * A line can be blocked for two reasons, and the two need different sentences:
 * "not eligible" is the policy refusing it, while an R-12 review line is going
 * to a person and the customer should not be told it is refused before anyone
 * has read the claim for it.
 */
function partialExcluded(decision: RefundDecision): string {
  const { ineligible, review } = partitionBlocked(decision);
  const sentences: string[] = [];
  if (ineligible.length > 0) {
    sentences.push(
      `${ineligible.map((item) => item.name).join(' and ')} ${
        ineligible.length === 1 ? 'is' : 'are'
      } not eligible for a refund on this order.`,
    );
  } else if (review.length === 0) {
    sentences.push('The rest of the order is not refundable under our policy.');
  }
  if (review.length > 0) {
    sentences.push(
      `${review.map((item) => item.name).join(' and ')} ${
        review.length === 1 ? 'is' : 'are'
      } being checked by a member of our team before anything for ${review.length === 1 ? 'it' : 'them'} is refunded.`,
    );
  }
  return sentences.join(' ');
}

/**
 * Whether a blocked line belongs in the customer's reply.
 *
 * A denial that names whatever the policy excluded anywhere in the basket
 * blames lines the customer never mentioned: asked about the subscription,
 * told about the final-sale coat sitting beside it. An unnamed claim puts
 * the whole order in scope, which is the only case where every line may be
 * named - the resolver's `bearsOnClaim` twin, kept beside the words so the
 * sentence cannot drift from the decision.
 */
function inClaimedScope(decision: RefundDecision, itemId: string): boolean {
  const claimed = decision.claimedItemIds;
  return claimed === undefined || claimed.length === 0 || claimed.includes(itemId);
}

/**
 * Splits the blocked lines into the two things they can be: a line the policy
 * refused ("not eligible") and a line R-12 sent for a person to read ("being
 * reviewed"). They must not share a sentence, because one says no and the other
 * says "not yet".
 */
function partitionBlocked(decision: RefundDecision): {
  ineligible: RefundDecision['blockedItems'];
  review: RefundDecision['blockedItems'];
} {
  return {
    ineligible: decision.blockedItems.filter((item) => item.ruleId !== 'R-12'),
    review: decision.blockedItems.filter((item) => item.ruleId === 'R-12'),
  };
}

export function composeDeterministicResponse(
  decision: RefundDecision,
  order: OrderRecord | null,
  message: string,
): string {
  // Prepended, never substituted for: the decision and its wording stay exactly
  // as they would be without it, so an acknowledgement cannot change what the
  // customer is told they are owed.
  const acknowledgement = acknowledgementFor(message);
  const prefix = acknowledgement.length === 0 ? '' : `${acknowledgement} `;
  const reference = order === null ? '' : ` for order ${order.id}`;
  return prefix + decisionBody(decision, reference, prefix, order, message);
}

/**
 * What to call the order in a sentence that already says "your order".
 *
 * Naming it twice reads as a mistake to the person reading it: "an exchange for
 * your order for order ORD-1a2b" is what this produced. So the phrase drops
 * "your" when the number is available, and falls back to the generic wording
 * when there is no order to name - a request raised before an order was
 * identified has to still be answerable.
 */
function orderSubject(order: OrderRecord | null): string {
  return order === null ? 'your order' : `order ${order.id}`;
}

/** The decision's own words, without the acknowledgement prefix. */
function exchangeSentence(order: OrderRecord | null, message: string): string {
  // An exchange usually answers a question the customer asked - "can I swap
  // it?" - so the reply answers it back. A verdict sentence ("we have decided
  // the outcome is exchange") states machinery instead of answering, and it is
  // what the customer hears as brusque. When the message did not ask, the
  // arrangement wording stands on its own.
  if (asksForSwap(message)) {
    return 'Yes - we will swap it instead.';
  }
  return `We have arranged an exchange for ${orderSubject(order)}.`;
}

/**
 * The "these lines are not eligible" sentence, or empty.
 *
 * A refusal answers "why not", so on a denial it stays on the dispute:
 * only claimed lines may be named. Payments are not narrowed - an approval
 * names what is not coming too.
 */
function excludedSentence(
  decision: RefundDecision,
  ineligible: RefundDecision['blockedItems'],
): string {
  const scoped =
    decision.decision === 'denied'
      ? ineligible.filter((item) => inClaimedScope(decision, item.itemId))
      : ineligible;
  if (scoped.length === 0 || (decision.decision === 'denied' && refusedWholeOrder(decision))) {
    return '';
  }
  return ` ${scoped.map((item) => item.name).join(' and ')} ${
    scoped.length === 1 ? 'is' : 'are'
  } not eligible for a refund on this order.`;
}

function decisionBody(
  decision: RefundDecision,
  reference: string,
  prefix: string,
  order: OrderRecord | null,
  message: string,
): string {
  const { ineligible } = partitionBlocked(decision);
  // A refusal answers "why not", so it stays on the dispute: asked about the
  // subscription, the customer must not be told about the final-sale coat
  // sitting beside it. Payments disclose more broadly - an approval names
  // what is not coming too, because "approved" alone reads as the whole
  // basket going back.
  const excluded = excludedSentence(decision, ineligible);

  switch (decision.decision) {
    case 'approved':
      return (
        prefix +
        `Your refund of ${formatCents(decision.refundAmountCents)}${reference} has been approved.` +
        excluded +
        ' It is being checked by a member of our team before it is sent,' +
        ' and it will go back to your original payment method once they have.'
      );
    case 'partial_refund':
      return (
        prefix +
        `We have refunded ${formatCents(decision.refundAmountCents)}${reference} for the items that ` +
        `are eligible. ${partialExcluded(decision)} ` +
        'If you think we have the details wrong, reply to this message and a person will review it.'
      );
    case 'exchange':
      return (
        prefix +
        exchangeSentence(order, message) +
        ' A member of our team will ' +
        'confirm the details with you here - you do not need to do anything else.'
      );
    case 'store_credit':
      return (
        prefix +
        `We have added store credit to your account for ${orderSubject(order)}. A member of our ` +
        'team will confirm the details with you here - you do not need to do anything else.'
      );
    case 'denied':
      return (
        prefix +
        `We are not able to refund this order${reference}.${excluded} ` +
        outstandingFor(decision) +
        'This decision was made automatically under our published refund policy. ' +
        'If you believe we have the details wrong, reply to this message and a person will review it.'
      );
    default:
      return prefix + escalationReason(decision);
  }
}

/**
 * Why this went to a person, in the customer's language.
 *
 * "A person is reviewing your request" tells a customer nothing they can act on, and an
 * escalation they cannot explain is one they take to someone else. So the message has
 * two reason-specific parts: the deciding rule spoken in plain words - never by its
 * number, never with a policy citation - and what the person will do next, so a
 * routine handoff reads differently from a history check or a mismatch review.
 * The sentence stays safe to send verbatim while still telling the person what to expect.
 */
function escalationReason(decision: RefundDecision): string {
  return (
    `A person is reviewing your request and will reply within one business day, because ${reasonFor(decision)} ` +
    `${expectationFor(decision)} ` +
    'Nothing further is needed from you.'
  );
}

/**
 * The rule-to-sentence table, as data.
 *
 * A `switch` over sixteen rules reads as logic and lints as complexity; this is what it
 * actually is - one sentence per rule, saying the decision rather than citing the
 * policy. A rule with no sentence falls through to the honest default rather than
 * leaking an id into a customer's inbox.
 */
const REASON_BY_RULE: Readonly<Record<string, string>> = {
  'R-01': 'it falls outside the window we can decide on our own.',
  'R-01b': 'it is past the standard window and needs a person to weigh the reason.',
  'R-02': 'the item is marked final sale, which we cannot decide on our own.',
  'R-03': 'the amount is above what we can approve without a person checking it.',
  'R-03b': 'the amount changed as lines were excluded, so it needs a person to check it.',
  'R-04': 'the reason needs someone to look at the detail.',
  'R-05': 'the item is a digital good that has already been downloaded.',
  'R-06': 'the payment needs checking against this order.',
  'R-06b': 'the amount goes beyond what was paid on this case.',
  'R-07': 'there is an open payment dispute on this case.',
  'R-08': 'we need to check the history of this order before refunding it.',
  'R-09': 'what you have told us does not match what we already have on file.',
  'R-10': 'recurring charges are handled by billing rather than refunds.',
  'R-11': 'there is already a request open for this order.',
  'R-12': 'we could not read the detail of your message well enough to decide it ourselves.',
  'R-13': 'we could not work out which order this is about.',
  'R-14': 'the message asked us to change our policy, which we cannot do.',
  'R-15': 'the total on this case is above what we can decide on our own.',
};

/**
 * What the person will do next, per deciding rule.
 *
 * The reason says why a person is needed; this says what happens now, so two
 * escalations with different causes do not read as the same message. Risk
 * reasons (history, mismatch, policy-change) get deliberately neutral words -
 * "look at", "compare", "confirm" - because the customer is owed the next step,
 * not an accusation, and the person has not decided anything yet.
 *
 * Each sentence must stay inside the phrasing guard's vocabulary: no decision
 * verbs (approve, deny, partial, exchange, store credit), no money words or
 * figures, no "your order", no timelines or promises, no rule ids. The guard
 * only checks model output, but the deterministic text is what no-model
 * deployments send, so it holds itself to the same bar.
 */
const EXPECTATION_BY_RULE: Readonly<Record<string, string>> = {
  'R-01': 'They will check the dates on this case and explain what options are still open.',
  'R-01b': 'They will weigh the reason against the age of the case and reply here.',
  'R-02': 'They will look at the item and confirm what can be done for it.',
  'R-03': 'They will go over the amount and confirm it here before anything moves.',
  'R-03b': 'They will go over the remaining amount and reply here.',
  'R-04': 'They will read through what you told us and reply here with the next step.',
  'R-05': 'They will look at the download record and confirm what can be done.',
  'R-06': 'They will match the payment against this case and reply here.',
  'R-06b': 'They will go over the balance and reply here.',
  'R-07': 'They will look at the dispute and reply here with the next step.',
  'R-08': 'They will look at the earlier requests on this case and reply here.',
  'R-09': 'They will compare what you told us with what is on file and reply here.',
  'R-10': 'They will check the billing side of this case and reply here.',
  'R-11': 'They will pick up the request that is already open, so there is no need to send it again.',
  'R-12': 'They will read it again carefully and reply here.',
  'R-13': 'They will work out which case this belongs to and reply here.',
  'R-14': 'They will reply here to confirm what the policy allows.',
  'R-15': 'They will go over the total and confirm it here before anything moves.',
};

const DEFAULT_EXPECTATION = 'They will read the case from the start and reply here.';

/** The rule that concluded the decision, if any rule did. */
function decidingEvaluation(decision: RefundDecision): RuleEvaluation | null {
  const objected = decision.trace.filter((rule) => rule.outcome !== 'pass');
  if (objected.length === 0) {
    return null;
  }
  // Cited reasons stay on the dispute: an objection about a line the customer
  // never claimed - the subscription sitting unmentioned in the same basket -
  // is true of the order and false of the case, and citing it answers a
  // question nobody asked. Order verdicts always bear; an unnamed claim puts
  // the whole order in scope.
  const claimed = decision.claimedItemIds ?? [];
  if (claimed.length === 0) {
    return objected[0] ?? null;
  }
  return (
    objected.find(
      (rule) =>
        rule.scope === 'order' ||
        rule.itemIds.length === 0 ||
        rule.itemIds.some((id) => claimed.includes(id)),
    ) ?? null
  );
}

/**
 * The sentence for whichever rule reached a conclusion.
 *
 * Exported because the phrasing envelope needs the same words: the customer
 * must always hear *why* their case was escalated, and two sources for that
 * sentence would drift into two different reasons.
 *
 * "Whichever reached a conclusion" rather than "the first": on a clean request no rule
 * concluded anything, which is the ordinary "nothing objected, but nothing concluded"
 * escalation. Saying so is the truth, and a vague reassurance would be a small lie.
 */
export function reasonFor(decision: RefundDecision): string {
  const deciding = decidingEvaluation(decision);
  const sentence = deciding === null ? undefined : REASON_BY_RULE[deciding.ruleId];
  return sentence ?? 'it needs a person to decide rather than a rule.';
}

/** The next-step sentence for whichever rule reached a conclusion. */
function expectationFor(decision: RefundDecision): string {
  const deciding = decidingEvaluation(decision);
  const ruleId = deciding?.ruleId;
  return ruleId === undefined ? DEFAULT_EXPECTATION : (EXPECTATION_BY_RULE[ruleId] ?? DEFAULT_EXPECTATION);
}
