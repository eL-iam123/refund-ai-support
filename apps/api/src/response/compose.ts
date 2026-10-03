import type { RefundDecision } from '@refund/shared';
import type { OrderRecord } from '../db/records.js';
import { formatCents } from '../lib/money.js';
import { acknowledgementFor } from './acknowledge.js';

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
  return prefix + decisionBody(decision, reference, prefix, order);
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
function decisionBody(
  decision: RefundDecision,
  reference: string,
  prefix: string,
  order: OrderRecord | null,
): string {
  const excluded =
    decision.blockedItems.length === 0 || (decision.decision === 'denied' && refusedWholeOrder(decision))
      ? ''
      : ` ${decision.blockedItems.map((item) => item.name).join(' and ')} ${
          decision.blockedItems.length === 1 ? 'is' : 'are'
        } not eligible for a refund on this order.`;

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
        'are eligible. The rest of the order is not refundable under our policy.' +
        ' If you think we have the details wrong, reply to this message and a person will review it.'
      );
    case 'exchange':
      return (
        prefix +
        `We have arranged an exchange for ${orderSubject(order)}. A member of our team will ` +
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
 * escalation they cannot explain is one they take to someone else. So the deciding rule
 * is spoken in plain words - never by its number, never with a policy citation - and the
 * sentence stays safe to send verbatim while still telling the person what to expect.
 */
function escalationReason(decision: RefundDecision): string {
  return (
    `A person is reviewing your request and will reply within one business day, because ${reasonFor(decision)} ` +
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
  'R-01b': 'it falls outside the window we can decide on our own.',
  'R-02': 'the item cannot be refunded automatically.',
  'R-03': 'the amount is above what we can approve without a person checking it.',
  'R-03b': 'the amount needs someone to look at the detail.',
  'R-04': 'the reason needs someone to look at the detail.',
  'R-05': 'the item cannot be refunded automatically.',
  'R-06': 'the payment needs checking against this order.',
  'R-06b': 'the payment needs checking against this order.',
  'R-07': 'we need to check the history of this order before refunding it.',
  'R-08': 'we need to check the history of this order before refunding it.',
  'R-09': 'what you have told us does not match what we already have on file.',
  'R-10': 'the item cannot be refunded automatically.',
  'R-11': 'there is already a request open for this order.',
  'R-12': 'we could not read the detail of your message well enough to decide it ourselves.',
  'R-13': 'we could not work out which order this is about.',
  'R-14': 'the message asked us to change our policy, which we cannot do.',
};

/**
 * The sentence for whichever rule reached a conclusion.
 *
 * "Whichever reached a conclusion" rather than "the first": on a clean request no rule
 * concluded anything, which is the ordinary "nothing objected, but nothing concluded"
 * escalation. Saying so is the truth, and a vague reassurance would be a small lie.
 */
function reasonFor(decision: RefundDecision): string {
  const deciding = decision.trace.find((rule) => rule.outcome !== 'pass');
  const sentence = deciding === undefined ? undefined : REASON_BY_RULE[deciding.ruleId];
  return sentence ?? 'it needs a person to decide rather than a rule.';
}
