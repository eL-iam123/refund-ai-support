import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { appendAuditEvent } from './auditChain.js';
import { latestRequestForThread } from './requestRepository.js';
import { activeHandoffForCustomer } from './handoffs.js';

export interface ChatClosure {
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly requestId: string;
  readonly closedAt: string;
  readonly closedBy: string;
  readonly finalState: 'approved' | 'denied';
}

interface ChatClosureRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly request_id: string;
  readonly closed_at: string;
  readonly closed_by: string;
  readonly final_state: 'approved' | 'denied';
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

/** Return the final request when the latest thread outcome is safe to close. */
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
  if (latest.decision !== 'approved') {
    return null;
  }
  const completedRefund = db.prepare(
    "SELECT 1 AS present FROM refunds WHERE request_id = ? AND status IN ('settled', 'released') LIMIT 1",
  ).get(latest.id);
  return completedRefund === undefined ? null : latest.id;
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
    finalState: request.decision === 'approved' ? 'approved' : 'denied',
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
