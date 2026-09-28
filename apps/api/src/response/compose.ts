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
function outstandingSentence(decision: RefundDecision): string {
  if (decision.outstandingAmountCents <= 0) {
    return '';
  }
  const amount = formatCents(decision.outstandingAmountCents);
  return `A refund of ${amount} ${outstandingPhrase(decision.outstandingState)}. `;
}

function outstandingPhrase(state: RefundDecision['outstandingState']): string {
  switch (state) {
    case 'pending':
      return 'is approved for this order and is waiting to be checked';
    case 'settled':
      return 'has already been refunded';
    default:
      return 'is already being processed';
  }
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
  const excluded =
    decision.blockedItems.length === 0
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
    case 'denied':
      return (
        prefix +
        `We are not able to refund this order${reference}.${excluded} ` +
        outstandingSentence(decision) +
        'This decision was made automatically under our published refund policy. ' +
        'If you believe we have the details wrong, reply to this message and a person will review it.'
      );
    default:
      return (
        prefix +
        'A person is reviewing your request and will reply within one business day.' +
        excluded +
        ' Nothing further is needed from you.'
      );
  }
}
