import type { NewRequestRow } from './requestRepository.js';
import { insertAuditEvent, insertRequest } from './requestRepository.js';
import { authoriseRefund } from './refundLedger.js';
import { formatCents } from '../lib/money.js';
import type { Db } from './connection.js';

/**
 * The one place an approval becomes money.
 *
 * This existed inside the chat route, which worked while that route was the only
 * caller and stopped being true the moment anything else resolved a claim. The
 * resolver's central promise is that an approved amount is held: R-06b refuses
 * to let one order be promised twice, and that only holds if every approval is
 * reserved. Enforced in a route, the guarantee depends on every future caller
 * remembering to duplicate a block of code. Enforced here, it cannot be split:
 * there is a single function that persists a decision, and it reserves.
 *
 * One transaction, for the same reason the audit event shares it: a request row
 * with no audit event, or an approval with no reservation, are both half-records
 * that the rest of the system cannot tell apart from a complete one.
 */
export function persistDecision(
  db: Db,
  row: NewRequestRow,
  context: { readonly orderId: string | null; readonly customerId: string; readonly now: Date },
): { readonly reservedCents: number; readonly reservationId: string | null } {
  const persist = db.transaction(() => {
    insertRequest(db, row);
    insertAuditEvent(
      db,
      row.id,
      row.createdAt,
      'decision',
      `${row.decision} ${formatCents(row.refundAmountCents)} via ${row.aiMode}`,
    );

    if (row.decision !== 'approved' || row.refundAmountCents <= 0 || context.orderId === null) {
      return { reservedCents: 0, reservationId: null };
    }

    // Recorded as awaiting verification, not as paid. Nothing here moves money;
    // a person confirms the claim before it leaves the till.
    const reservation = authoriseRefund(db, {
      requestId: row.id,
      orderId: context.orderId,
      customerId: context.customerId,
      amountCents: row.refundAmountCents,
      now: context.now,
    });
    insertAuditEvent(
      db,
      row.id,
      row.createdAt,
      'refund_authorised',
      `${formatCents(row.refundAmountCents)} pending human verification`,
    );
    // The reservation id is surfaced because a seeder that replays history has
    // to settle the money a real approval reserved - a refund that was approved
    // in the demo and settled nowhere would look like money stuck in review
    // forever.
    return { reservedCents: reservation.amountCents, reservationId: reservation.id };
  });

  return persist();
}
