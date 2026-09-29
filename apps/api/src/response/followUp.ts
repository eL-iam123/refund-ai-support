import { formatCents } from '../lib/money.js';

/**
 * What the customer is told when a person acts on their request.
 *
 * Composed, not generated. The same reason the rest of the customer's replies
 * are composed: a sentence about money is read as a promise, so it has to be
 * traceable to a figure and a rule rather than to a model that was asked to be
 * helpful. A model can be wrong here in a way that is invisible afterwards -
 * "your refund has been sent" when it has not - and there is nothing in the
 * output a reviewer could check.
 *
 * What the model *does* do in this system is read the complaint. The decision
 * and this message are both downstream of a human having acted, and neither
 * asks the model's opinion.
 *
 * The wording is fixed when the action happens and stored, so what a customer
 * read last month is still what they read.
 */

/** The actions worth telling a customer about. */
export type FollowUpKind =
  /** An admin changed the decision the pipeline reached. */
  | 'human_decision'
  /** Money actually went out. */
  | 'refund_sent'
  /** A reservation was given back without being paid. */
  | 'refund_withdrawn';

export interface FollowUpFacts {
  readonly kind: FollowUpKind;
  readonly orderId: string | null;
  /** What the decision was before a person changed it. */
  readonly previousDecision: string;
  /** What the decision is now. */
  readonly decision: string;
  /** Authorised for payment. Zero unless approved. */
  readonly amountCents: number;
  /** Paid out. Only ever non-zero for `refund_sent`. */
  readonly paidCents: number;
}

/**
 * The message, in the customer's own terms.
 *
 * Three rules hold across every branch, and each one exists because breaking it
 * would be a lie rather than an imprecision:
 *
 *  - An approved refund is never described as paid until `refund_sent`. The
 *    customer's original reply already says a person is checking it; this must
 *    not quietly upgrade that to done.
 *
 *  - A denial says what was refused and what to do next, and never the reason in
 *    terms of the model or the policy engine's internal vocabulary.
 *
 *  - A follow-up never introduces an amount the decision does not carry. If the
 *    amount is zero, no amount is named.
 */
export function followUpFor(facts: FollowUpFacts): string {
  const order = facts.orderId === null ? '' : ` for order ${facts.orderId}`;
  switch (facts.kind) {
    case 'human_decision':
      return humanDecision(facts, order);
    case 'refund_sent':
      return (
        `Your refund of ${formatCents(facts.paidCents)}${order} has been sent to your original ` +
        'payment method. Depending on your bank it can take a few days to appear.'
      );
    default:
      return (
        `The refund that was being held${order} has been withdrawn, so nothing was taken from ` +
        'your original payment method. Your request is still on file if you want to raise it again.'
      );
  }
}

function humanDecision(facts: FollowUpFacts, order: string): string {
  if (facts.decision === 'approved') {
    return (
      `A member of our team has reviewed your request${order} and approved a refund of ` +
      `${formatCents(facts.amountCents)}. It has been checked again before it is sent, and it will ` +
      'go back to your original payment method once it is.'
    );
  }
  if (facts.decision === 'denied') {
    return (
      `A member of our team has reviewed your request${order} and we are not able to refund it. ` +
      'If you have information we did not have when we looked at it, reply here and it will be ' +
      'looked at again.'
    );
  }
  return (
    `A member of our team has looked at your request${order}. We are still checking it, and ` +
    'nothing further is needed from you right now.'
  );
}
