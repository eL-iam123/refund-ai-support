import { randomUUID } from 'node:crypto';
import { MONEY_DECISIONS, type Decision } from '@refund/shared';
import type { Db } from './connection.js';
import { appendAuditEvent } from './auditChain.js';
import { latestRequestForThread } from './requestRepository.js';
import { activeHandoffForCustomer, ESCALATION_AGENT } from './handoffs.js';

export interface ChatClosure {
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly requestId: string;
  readonly closedAt: string;
  readonly closedBy: string;
  /**
   * The decision this thread closed on.
   *
   * A `Decision` rather than a two-value summary, and the distinction is the whole
   * point of the column: a closure is the last word said to a customer about their
   * money, and a thread closed after a partial refund recorded as `denied` is a
   * record that contradicts the ledger sitting next to it.
   */
  readonly finalState: Decision;
}

interface ChatClosureRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly request_id: string;
  readonly closed_at: string;
  readonly closed_by: string;
  readonly final_state: Decision;
}

export class ChatNotFinalizedError extends Error {
  constructor() {
    super('this conversation cannot be closed until its request is finalized');
    this.name = 'ChatNotFinalizedError';
  }
}

export function chatClosureForThread(db: Db, customerId: string, orderId: string | null): ChatClosure | null {
  const row = db.prepare(
    `SELECT id, customer_id, order_id, request_id, closed_at, closed_by, final_state
       FROM chat_closures WHERE customer_id = ? AND order_id IS ? LIMIT 1`,
  ).get(customerId, orderId) as ChatClosureRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function isChatClosed(db: Db, customerId: string, orderId: string | null): boolean {
  return chatClosureForThread(db, customerId, orderId) !== null;
}

/**
 * Return the final request when the latest thread outcome is safe to close.
 *
 * Closing a thread is the last thing that happens to a conversation, so each
 * decision asks a different question about whether that time has come:
 *
 *  - Money decisions wait for the money. `approved` and `partial_refund` are both
 *    `MONEY_DECISIONS`, and both hold a reservation in the ledger until a person
 *    settles it, so neither is finished until that row is settled or released.
 *    Treating a partial refund as anything other than an approval used to make it
 *    permanently uncloseable.
 *  - A denial waits for the appeal window, because a refusal the customer can still
 *    contest is not the end of the conversation.
 *  - `exchange` and `store_credit` resolve the request without moving money, but
 *    they are not self-executing: the customer is told a member of the team will
 *    confirm the details *in this thread*. So they finalise only once an agent
 *    has actually handled the thread - a handoff on this order has been taken and
 *    ended. That is what makes the confirmation possible before the conversation
 *    ends, and it is why these outcomes are closable at all rather than stuck.
 *  - `escalated` on its own is never finalisable: it means a person still owes
 *    an answer. Once a person has taken the thread - holding it now or having
 *    handed it back - the answer is being or has been given in person, and the
 *    thread finalises like any other handled one. Without this, a case a
 *    person resolved could never be closed, and every resolved escalation
 *    stayed open forever.
 */
export function finalizedRequestId(db: Db, customerId: string, orderId: string | null): string | null {
  const latest = latestRequestForThread(db, customerId, orderId);
  if (latest === null) {
    return null;
  }
  if (latest.decision === 'denied') {
    const openAppeal = db.prepare(
      'SELECT 1 AS present FROM appeals WHERE request_id = ? AND decided_at IS NULL LIMIT 1',
    ).get(latest.id);
    return openAppeal === undefined ? latest.id : null;
  }
  if (MONEY_DECISIONS.has(latest.decision)) {
    const completedRefund = db.prepare(
      "SELECT 1 AS present FROM refunds WHERE request_id = ? AND status IN ('settled', 'released') LIMIT 1",
    ).get(latest.id);
    return completedRefund === undefined ? null : latest.id;
  }
  // Anything else finalises once a person has owned the thread to its end.
  // Money waits above regardless of who handled it, and a denial under appeal
  // waits too; the rest is a conversation a human has finished having.
  return agentHasHandledThread(db, latest.customerId, orderId) ? latest.id : null;
}

/**
 * Whether a person has taken this thread.
 *
 * A finished handoff is the evidence it happened - but so is a live one held
 * by a named agent: closing ends their takeover too, and requiring a hand-back
 * first would add a round trip without adding any protection, since handing
 * back resolves nothing either. The automatic escalation marker never counts,
 * with or without an end date: nobody is on an unattended thread, so there is
 * no one whose handling the closure could record.
 */
function agentHasHandledThread(db: Db, customerId: string, orderId: string | null): boolean {
  const handled = db
    .prepare(
      `SELECT 1 AS present
         FROM handoffs
        WHERE customer_id = ? AND order_id IS ?
          AND (ended_at IS NOT NULL OR agent_id <> ?)
        LIMIT 1`,
    )
    .get(customerId, orderId, ESCALATION_AGENT);
  return handled !== undefined;
}

export function closeFinalizedChat(
  db: Db,
  input: { readonly customerId: string; readonly orderId: string | null; readonly closedBy: string; readonly now: Date },
): ChatClosure {
  const existing = chatClosureForThread(db, input.customerId, input.orderId);
  if (existing !== null) {
    return existing;
  }
  const requestId = finalizedRequestId(db, input.customerId, input.orderId);
  const request = requestId === null ? null : latestRequestForThread(db, input.customerId, input.orderId);
  if (requestId === null || request === null) {
    throw new ChatNotFinalizedError();
  }

  const closure: ChatClosure = {
    id: `CLOSE-${randomUUID()}`,
    customerId: input.customerId,
    orderId: input.orderId,
    requestId,
    closedAt: input.now.toISOString(),
    closedBy: input.closedBy,
    finalState: request.decision,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_closures (id, customer_id, order_id, request_id, closed_at, closed_by, final_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(closure.id, closure.customerId, closure.orderId, closure.requestId, closure.closedAt, closure.closedBy, closure.finalState);

    const handoff = activeHandoffForCustomer(db, input.customerId);
    if (handoff !== null && handoff.orderId === input.orderId) {
      db.prepare('UPDATE handoffs SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(closure.closedAt, handoff.id);
    }

    appendAuditEvent(db, {
      requestId: closure.requestId,
      at: closure.closedAt,
      kind: 'chat_closed',
      detail: `chat closed by ${closure.closedBy} after ${closure.finalState} finalization`,
    });
  })();

  return closure;
}

function hydrate(row: ChatClosureRow): ChatClosure {
  return {
    id: row.id,
    customerId: row.customer_id,
    orderId: row.order_id,
    requestId: row.request_id,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    finalState: row.final_state,
  };
}
