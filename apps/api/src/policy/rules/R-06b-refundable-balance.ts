import { deny, pass, type PolicyRule } from '../types.js';
import { FULLY_REFUNDED } from '../constants.js';
import { settledCentsForOrder, pendingCentsForOrder } from '../../db/refundLedger.js';
import type { Db } from '../../db/connection.js';

/**
 * R-06b - refundable balance.
 *
 * R-06 asks whether the *payment* has been settled or refunded. This asks what is
 * left to give back once money already committed to this order is counted: the
 * payments that have gone out, plus the approvals still waiting for a person to
 * check them.
 *
 * It exists because an approval reserves money. Without it, a customer with one
 * $177 order can have it approved four times over while the first claim sits in
 * the verification queue, and every one of those rows is a promise the business
 * cannot keep. Counting pending approvals as spent is the conservative reading:
 * it may refuse a claim the business would have honoured, and the fix for that is
 * a person settling the queue, not a rule that lets the order be over-promised.
 */
export const R06bRefundableBalance: PolicyRule = {
  id: 'R-06b',
  title: 'No refundable balance remaining',
  ruleClass: 'eligibility',
  scope: 'order',
  stage: 'fact_gates',
  policyRef: 'REFUND_POLICY.md §2.5',
  summary:
    'An order cannot be refunded beyond what was paid, counting approvals already awaiting verification.',
  evaluate(context) {
    const order = context.order;
    if (order === null) {
      return pass(this, 'no order resolved; balance not applicable');
    }

    // The order's own count and the ledger's can disagree: a refund settled
    // before this table existed, or one recorded by the payment provider rather
    // than by this system. Taking the larger of the two means the gate never
    // under-counts money that has already left, which is the direction that
    // costs the customer money. Under-counting is the expensive mistake here,
    // so this is deliberately not a reconciliation and not an assertion.
    if (order.paymentState === FULLY_REFUNDED && order.refundedCents >= order.totalCents) {
      // R-06 already refuses this order outright, and it is the clause written
      // for it. Two rules denying the same order would put two reasons in front
      // of a reviewer for one outcome, and the second would be noise that has to
      // be read past to find the real one.
      return pass(this, 'order already refused in full by R-06; balance not reached');
    }

    const settled = Math.max(order.refundedCents, settledCentsForOrder(context.db, order.id));
    const pending = pendingCentsForOrder(context.db, order.id);
    const remaining = order.totalCents - settled - pending;

    if (remaining <= 0) {
      const detail =
        pending > 0
          ? `${settled} cents refunded and ${pending} already awaiting verification, of ${order.totalCents} paid`
          : `${settled} cents already refunded, of ${order.totalCents} paid`;
      return deny(this, `nothing left to refund: ${detail}`);
    }
    return pass(this, `${remaining} cents of ${order.totalCents} remain refundable`);
  },
};

/**
 * The balance the resolver may not exceed, in cents. 0 when nothing remains.
 *
 * `alreadyRefundedCents` is the order's own figure, passed in so this counts the
 * same money the rule does; the ledger alone would miss a refund settled outside
 * it. Passing the number rather than the order keeps this usable from a context
 * that has no `OrderRecord`.
 */
export function refundableRemainingCents(
  db: Db,
  orderId: string,
  orderTotalCents: number,
  alreadyRefundedCents = 0,
): number {
  const settled = Math.max(alreadyRefundedCents, settledCentsForOrder(db, orderId));
  return Math.max(0, orderTotalCents - settled - pendingCentsForOrder(db, orderId));
}
