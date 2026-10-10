import { randomUUID } from 'node:crypto';
import { MONEY_DECISIONS, type Decision } from '@refund/shared';
import type { Db } from './connection.js';
import { appendAuditEvent } from './auditChain.js';
import { latestRequestForThread } from './requestRepository.js';
import type { PersistedRequest } from './records.js';
import { ESCALATION_AGENT, liveHandoffForThread } from './handoffs.js';

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
  /**
   * The order lines this closure finalised, by order_items id.
   *
   * Null is not "none": it is a row written before closures were line-scoped,
   * and those closed the whole thread. New closures always write an explicit
   * list. The distinction is what keeps a replayed migration from reopening
   * cases an agent put away under the old rule.
   */
  readonly closedItemIds: readonly string[] | null;
}

interface ChatClosureRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly request_id: string;
  readonly closed_at: string;
  readonly closed_by: string;
  readonly final_state: Decision;
  readonly closed_item_ids_json: string | null;
}

export class ChatNotFinalizedError extends Error {
  constructor() {
    super('this conversation cannot be closed until its request is finalized');
    this.name = 'ChatNotFinalizedError';
  }
}

export function chatClosureForThread(db: Db, customerId: string, orderId: string | null): ChatClosure | null {
  const row = db.prepare(
    `SELECT id, customer_id, order_id, request_id, closed_at, closed_by, final_state, closed_item_ids_json
       FROM chat_closures WHERE customer_id = ? AND order_id IS ? LIMIT 1`,
  ).get(customerId, orderId) as ChatClosureRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function isChatClosed(db: Db, customerId: string, orderId: string | null): boolean {
  const closure = chatClosureForThread(db, customerId, orderId);
  if (closure === null) {
    return false;
  }
  // A row from before line-scoping closed the whole thread, as does a closure
  // with no order to scope it to. Otherwise the thread is closed only when
  // every line on the order is closed: finalising the lamp must not bury the
  // kettle sitting in the same cart.
  if (closure.closedItemIds === null || orderId === null) {
    return true;
  }
  const closed = new Set(closure.closedItemIds);
  return orderLineIds(db, orderId).every((id) => closed.has(id));
}

/**
 * The lines a closure speaks for, for the report wizard.
 *
 * Empty when the thread is open. A legacy row (no line set) counts every line
 * on the order as closed, because that is what closing meant when it was
 * written - the wizard must show those lines as finished, not as reportable.
 */
export function closedItemIdsForThread(db: Db, customerId: string, orderId: string | null): readonly string[] {
  const closure = chatClosureForThread(db, customerId, orderId);
  if (closure === null) {
    return [];
  }
  if (closure.closedItemIds !== null) {
    return closure.closedItemIds;
  }
  if (orderId === null) {
    return [];
  }
  return orderLineIds(db, orderId);
}

/** Every line id on an order, in stable order. */
function orderLineIds(db: Db, orderId: string): readonly string[] {
  const rows = db
    .prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId) as { id: string }[];
  return rows.map((row) => row.id);
}

/** A JSON id list that refuses to be anything else. Null on any doubt, which reads as legacy. */
function parseItemIds(json: string): readonly string[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
}

/**
 * Every line on a thread that already has its answer: claimed, eligible, or
 * refused, across all decided requests - never the escalated ones, which are
 * still with a person.
 *
 * Union rather than latest-only, because closes are rarer than decisions: the
 * lamp paid out months ago without anyone closing, and the kettle decided
 * today, close once and both are put away. Lines outside the union were never
 * mentioned, so they stay reportable.
 */
function decidedLineIdsForThread(db: Db, customerId: string, orderId: string | null): readonly string[] {
  const rows = db
    .prepare(
      `SELECT claim_item_ids_json, eligible_item_ids_json, blocked_items_json
         FROM refund_requests WHERE customer_id = ? AND order_id IS ? AND decision <> 'escalated'`,
    )
    .all(customerId, orderId) as {
    claim_item_ids_json: string;
    eligible_item_ids_json: string;
    blocked_items_json: string;
  }[];
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of parseItemIds(row.claim_item_ids_json) ?? []) {
      ids.add(id);
    }
    for (const id of parseItemIds(row.eligible_item_ids_json) ?? []) {
      ids.add(id);
    }
    for (const id of parseBlockedIds(row.blocked_items_json)) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** The item ids a refused-lines list names, defensively parsed. */
function parseBlockedIds(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (item): item is { itemId: string } =>
          typeof item === 'object' && item !== null && typeof (item as { itemId?: unknown }).itemId === 'string',
      )
      .map((item) => item.itemId);
  } catch {
    return [];
  }
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
  const requestId = finalizedRequestId(db, input.customerId, input.orderId);
  const request = requestId === null ? null : latestRequestForThread(db, input.customerId, input.orderId);
  const closedAt = input.now.toISOString();

  // A thread closed once already can be closed again for lines decided since:
  // the lamp's closure stays, and the kettle's lines merge into it. A legacy
  // row (no line set) already closed everything, and a re-close with nothing
  // new finalized is idempotent either way - closing never throws for a
  // thread that is already put away.
  if (existing !== null) {
    const alreadyClosed = existing.closedItemIds;
    if (alreadyClosed === null || request === null) {
      return existing;
    }
    return mergeClosure(db, input, existing, alreadyClosed, request, closedAt);
  }

  if (requestId === null || request === null) {
    throw new ChatNotFinalizedError();
  }
  return insertClosure(db, input, request, closedAt);
}

/** Folds newly decided lines into an existing closure, or keeps it untouched. */
function mergeClosure(
  db: Db,
  input: { readonly customerId: string; readonly orderId: string | null; readonly closedBy: string; readonly now: Date },
  existing: ChatClosure,
  alreadyClosed: readonly string[],
  request: PersistedRequest,
  closedAt: string,
): ChatClosure {
  const merged = [...new Set([...alreadyClosed, ...decidedLineIdsForThread(db, input.customerId, input.orderId)])];
  if (merged.length === alreadyClosed.length) {
    return existing;
  }
  const mergedClosure: ChatClosure = {
    ...existing,
    requestId: request.id,
    closedAt,
    closedBy: input.closedBy,
    finalState: request.decision,
    closedItemIds: merged,
  };
  db.transaction(() => {
    db.prepare(
      `UPDATE chat_closures
          SET request_id = ?, closed_at = ?, closed_by = ?, final_state = ?, closed_item_ids_json = ?
        WHERE id = ?`,
    ).run(request.id, closedAt, input.closedBy, request.decision, JSON.stringify(merged), existing.id);
    endLiveHandoff(db, input.customerId, input.orderId, closedAt);
    appendAuditEvent(db, {
      requestId: request.id,
      at: closedAt,
      kind: 'chat_closed',
      detail:
        `chat closed by ${input.closedBy} after ${request.decision} finalization ` +
        `(${merged.length} line(s) closed)`,
    });
  })();
  return mergedClosure;
}

/** Writes the first closure for a thread, naming the lines it puts away. */
function insertClosure(
  db: Db,
  input: { readonly customerId: string; readonly orderId: string | null; readonly closedBy: string; readonly now: Date },
  request: PersistedRequest,
  closedAt: string,
): ChatClosure {
  const lines = decidedLineIdsForThread(db, input.customerId, input.orderId);
  // An empty union keeps the old meaning: a decision that speaks for no
  // specific line speaks for the thread, so the row is written legacy-style
  // (null) and the thread closes wholesale rather than staying open on a
  // technicality.
  const scoped = lines.length === 0 ? null : lines;
  const closure: ChatClosure = {
    id: `CLOSE-${randomUUID()}`,
    customerId: input.customerId,
    orderId: input.orderId,
    requestId: request.id,
    closedAt,
    closedBy: input.closedBy,
    finalState: request.decision,
    closedItemIds: scoped,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_closures (id, customer_id, order_id, request_id, closed_at, closed_by, final_state, closed_item_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      closure.id,
      closure.customerId,
      closure.orderId,
      closure.requestId,
      closure.closedAt,
      closure.closedBy,
      closure.finalState,
      scoped === null ? null : JSON.stringify(scoped),
    );

    endLiveHandoff(db, input.customerId, input.orderId, closedAt);

    appendAuditEvent(db, {
      requestId: closure.requestId,
      at: closure.closedAt,
      kind: 'chat_closed',
      detail:
        `chat closed by ${closure.closedBy} after ${closure.finalState} finalization ` +
        `(${scoped === null ? 'all lines' : `${scoped.length} line(s)`} closed)`,
    });
  })();

  return closure;
}

/** Ends the live takeover on a closing thread, if one is still open. */
function endLiveHandoff(db: Db, customerId: string, orderId: string | null, at: string): void {
  const handoff = liveHandoffForThread(db, customerId, orderId);
  if (handoff !== null) {
    db.prepare('UPDATE handoffs SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(at, handoff.id);
  }
}

function hydrate(row: ChatClosureRow): ChatClosure {
  // An unparseable list reads as legacy - fully closed - rather than open:
  // a corrupt row must preserve what closing meant, not reopen it.
  const closed = row.closed_item_ids_json === null ? null : parseItemIds(row.closed_item_ids_json);
  return {
    id: row.id,
    customerId: row.customer_id,
    orderId: row.order_id,
    requestId: row.request_id,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    finalState: row.final_state,
    closedItemIds: closed,
  };
}
