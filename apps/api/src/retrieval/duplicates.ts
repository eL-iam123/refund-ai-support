import type { Db } from '../db/connection.js';
import { findDuplicateRequests, messageFingerprint, type DuplicateMatch } from '../db/requestRepository.js';
import { insertAuditEvent } from '../db/requestRepository.js';

/**
 * Recognising a report the customer has already made.
 *
 * The failure this prevents is ordinary and expensive: a customer sends a
 * complaint, sees nothing happen, and sends it again. The second message is a
 * *new* request as far as the pipeline is concerned - different id, different
 * row, fresh model call - so the same problem can be decided twice, and an
 * approval that reserves money is exactly the thing that must not happen twice.
 *
 * Three decisions are made here, and each one is the reason the check is not
 * simply a `LIKE` on the message:
 *
 *  1. **The model is never called for a repeat.** The gate runs before
 *     `processRefundRequest`, so a duplicate costs one indexed lookup instead of
 *     a provider call, and - more to the point - no second `ClaimExtraction` is
 *     ever produced for one complaint. The model is not asked to recognise its
 *     own duplicate; a deterministic hash decides it, because a check that can
 *     be talked out of by a well-phrased message is not a check.
 *
 *  2. **Nothing new is written.** No `refund_requests` row, therefore no refund
 *     reservation, therefore no second approval. The customer is shown the
 *     request they already have. This is why the gate belongs at the route
 *     rather than inside the pipeline: the pipeline returns a decision, and a
 *     decision that gets persisted is a second decision no matter what it says.
 *
 *  3. **The attempt is still recorded.** A suppressed request is invisible if it
 *     is not written down, and "the customer asked twice" is a real signal -
 *     usually that the first answer was not good enough. It goes to the audit
 *     chain, not to the request table, because it is not a decision.
 */
export interface DuplicateReport {
  readonly matches: readonly DuplicateMatch[];
  /** The earliest match, which is the one the customer should be shown. */
  readonly original: DuplicateMatch;
  /** The most recent match, so the audit record can show how often it was re-sent. */
  readonly newest: DuplicateMatch;
}

/**
 * The first duplicate the customer already has open, or null.
 *
 * The earliest match is returned rather than the newest: a customer asking twice
 * wants to be shown the request that started it, and "your most recent request"
 * is the wrong answer when all of them are the same complaint.
 */
export function findDuplicateReport(
  db: Db,
  customerId: string,
  message: string,
  now: Date,
  windowHours: number,
): DuplicateReport | null {
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
  const matches = findDuplicateRequests(db, customerId, messageFingerprint(message), since, MAX_MATCHES);
  // `findDuplicateRequests` returns newest-first for the admin listing, so the
  // original is the last of them. The length check above proves the index is in
  // range; the guard is here because the array type cannot say so.
  const original = matches[matches.length - 1];
  const newest = matches[0];
  return original === undefined || newest === undefined ? null : { matches, original, newest };
}

/** How many prior requests to consider. More than a handful is a different problem. */
const MAX_MATCHES = 5;

/**
 * Records that a repeat was received and answered with the existing request.
 *
 * Uses the original request's id, so the fact lands in the chain that a reviewer
 * would actually open for that complaint. Writing it against a throwaway id
 * would make the duplicate invisible to anyone reading the request they care
 * about.
 */
export function recordDuplicateAttempt(
  db: Db,
  customerId: string,
  duplicate: DuplicateReport,
  now: Date,
): void {
  insertAuditEvent(db, duplicate.original.id, now.toISOString(), 'duplicate_suppressed', JSON.stringify({
    customerId,
    suppressedCount: duplicate.matches.length,
    // Both ends are recorded because "asked once" and "asked four times" are
    // different problems: the first is a lost reply, the second is a customer
    // who believes the system is not listening.
    firstRequestId: duplicate.original.id,
    mostRecentRequestId: duplicate.newest.id,
    firstReportedAt: duplicate.original.createdAt,
  }));
}

/**
 * What to tell the customer.
 *
 * Says the request already exists, names when it was made, and points at the
 * order - because "already submitted" without a status is the reply that
 * generates the next message. Never says a decision was made twice, and never
 * promises an outcome the original request has not reached.
 */
export function duplicateResponseText(original: DuplicateMatch, decision: string): string {
  const when = new Date(original.createdAt).toLocaleString();
  const outcome = DECISION_PHRASES[decision] ?? 'is still being reviewed';
  return [
    `You have already reported this - we have your request from ${when} and it ${outcome}.`,
    'There is no need to send it again; it is the same request, not a new one.',
    original.orderId === null
      ? 'If something about it has changed since then, reply with what changed and a person will pick it up.'
      : `If something about order ${original.orderId} has changed since then, reply with what changed and a person will pick it up.`,
  ].join(' ');
}

/**
 * The customer's word for each decision.
 *
 * The decision is a resolver term, not a sentence. Presenting "escalated" to
 * someone who just wants their money back tells them nothing, so each state is
 * translated into what it means for them and what happens next.
 */
const DECISION_PHRASES: Readonly<Record<string, string>> = {
  approved: 'has been approved',
  denied: 'was reviewed and could not be approved',
  escalated: 'is with a person for review',
};
