import type { Db } from '../db/connection.js';
import { queryAll } from '../db/sql.js';
import { findOrder } from '../db/orderRepository.js';
import { listUpdatesForOrder } from '../db/customerUpdates.js';
import { listDialogueForOrder } from '../db/dialogue.js';
import { ESCALATION_AGENT, activeHandoffForCustomer, listAgentMessagesForOrder } from '../db/handoffs.js';
import { NotFoundError } from '../http/errors.js';
import type { DialogueLine } from '../ai/analyzer.js';

/**
 * A customer's conversation, per order.
 *
 * Everything the assistant already knows is already stored: `refund_requests`
 * holds the message, the composed reply, the decision and when it happened. This
 * turns those rows back into a thread, so an order's history survives a refresh
 * and is reachable from the order the customer is actually looking at.
 *
 * Three things this deliberately does not do:
 *
 *  - **Take a `customerId`.** The caller is identified by the session cookie and
 *    nothing else. A parameter here would be a parameter an attacker sets, and
 *    the whole query would be `WHERE customer_id = ?` - the safest query in the
 *    system turned into the most dangerous one by one extra field.
 *
 *  - **Check the order belongs to the customer and then read the rows.** The
 *    ownership check is not decoration: the history query filters by customer as
 *    well, but a filter that is the *only* defence is one refactor away from
 *    being dropped. Two independent conditions, either of which is sufficient.
 *
 *  - **Return the full request row.** A refund request carries the policy trace,
 *    the raw extraction, the injection scan and the timing breakdown. That is
 *    staff data. The customer gets the message they sent, the answer they were
 *    given, and the outcome - which is the whole of what a thread needs to read
 *    correctly.
 *
 * The staff view (`threadForStaff`) is the same merge without the ownership
 * check and with a nullable order, because a takeover can begin mid-clarify -
 * but it is still keyed by customer id from the staff session, never from a
 * caller-supplied one.
 */

/**
 * One entry in the thread.
 *
 * A `request` entry is the customer asking something and the answer they were
 * given. An `update` entry is the assistant telling them what a person later did
 * about it - approved, paid, or withdrawn - and carries no message, because the
 * customer did not send one. A `dialogue` entry is the assistant asking a
 * clarifying question and the customer message it answered - a question is not a
 * decision, so it has no request row, but it is still the customer's history.
 *
 * An `agent` entry is one message exchanged while a person was on the line: the
 * customer's routed words or the staff member's reply, told apart by `sender`.
 * A `handoff` entry is the moment the thread changed hands, rendered as the
 * "connecting you to a customer agent" notice - derived from the takeover row,
 * never stored as a message, so it cannot be sent out of context.
 *
 * The kinds are told apart in the type rather than by a null check at the
 * renderer, so a missing message is a compile error rather than an empty bubble.
 */
export type ChatTurn =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly message: string;
      readonly responseText: string;
      readonly decision: string;
      readonly refundAmountCents: number;
      readonly itemIds: readonly string[];
      readonly createdAt: string;
    }
  | {
      readonly kind: 'dialogue';
      readonly id: string;
      readonly message: string;
      readonly question: string;
      readonly itemIds: readonly string[];
      readonly createdAt: string;
    }
  | {
      readonly kind: 'update';
      readonly id: string;
      readonly requestId: string;
      readonly body: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly sender: 'agent' | 'customer';
      readonly body: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'handoff';
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
    };

interface TurnRow {
  readonly id: string;
  readonly message: string;
  readonly response_text: string;
  readonly decision: string;
  readonly refund_amount_cents: number;
  readonly eligible_item_ids_json: string | null;
  readonly claim_item_ids_json: string | null;
  readonly created_at: string;
}

/**
 * The thread for one order, oldest first.
 *
 * Oldest first because a conversation is read in order. A history rendered
 * newest-first is a history where the answer to the first question appears
 * below every later question that was asked after it was already answered.
 *
 * Capped, and capped in a way that takes the *oldest* of the most recent turns
 * rather than the oldest turns overall. A customer with fifty messages wants
 * their recent ones, not their first; a customer with three wants all three.
 *
 * The ordering is `created_at` then `rowid`, and the tiebreak is not decoration.
 * Two messages can share a timestamp - same millisecond, or a fixed clock in a
 * test - and the only column left to break the tie is `id`, a random UUID, which
 * orders them arbitrarily. A thread whose last two messages can swap places
 * between two page loads is not a thread. `rowid` is assigned in insertion order
 * and these rows are only ever inserted, so it is the one column here that
 * reliably means "which happened first".
 */
export function conversationForOrder(
  db: Db,
  customerId: string,
  orderId: string,
  now: Date,
  limit: number,
): readonly ChatTurn[] {
  // 404 rather than 403 for someone else's order. A 403 confirms the order
  // exists, which turns this into an order-id oracle - the same reasoning the
  // return ledger and the refund pipeline both rely on.
  if (findOrder(db, customerId, orderId, now) === null) {
    // The message names the order id back, which is the same phrasing the rest of
    // the shop uses for a missing thing. It deliberately does not say whose order
    // it is or that the order exists at all.
    throw new NotFoundError('order', orderId);
  }

  return thread(db, customerId, orderId, limit);
}

/**
 * The same thread as the customer sees, but for a staff member opening the case.
 *
 * Two differences, both load-bearing: there is **no ownership check**, because
 * the caller is a signed-in staff member and the order it is not theirs to own,
 * and the order id is **nullable**, because a takeover can be taken mid-clarify
 * before any order exists. The customer_id still comes only from the staff
 * session - never from the caller - so an agent can look at a customer, not
 * anyone else's.
 */
export function threadForStaff(
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): readonly ChatTurn[] {
  return thread(db, customerId, orderId, limit);
}

/** One candidate in the interleave, ranked so same-instant ties read in order. */
interface Entry {
  readonly turn: ChatTurn;
  readonly rank: number;
}

/** The shared merge behind both views. */
function thread(db: Db, customerId: string, orderId: string | null, limit: number): readonly ChatTurn[] {
  const entries: Entry[] = [];
  pushRequests(entries, db, customerId, orderId, limit);
  pushDialogue(entries, db, customerId, orderId, limit);
  pushUpdates(entries, db, customerId, orderId, limit);
  pushAgentMessages(entries, db, customerId, orderId, limit);
  pushHandoffNotice(entries, db, customerId);
  return sort(entries);
}

function pushRequests(
  entries: Entry[],
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): void {
  const rows = queryAll<TurnRow>(
    db.prepare(
      `SELECT id, message, response_text, decision, refund_amount_cents, eligible_item_ids_json, claim_item_ids_json, created_at
         FROM refund_requests
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );

  // Reversed rather than queried ascending: `ORDER BY … DESC LIMIT ?` is the only
  // way to take the *most recent* N without loading the whole thread, and a
  // conversation still has to be read in the order it happened.
  for (const turn of rows.map(hydrateTurn).reverse()) {
    entries.push({ turn, rank: 0 });
  }
}

function pushDialogue(
  entries: Entry[],
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): void {
  // Asked for separately rather than joined. A UNION ALL over tables that need
  // different orderings to be correct would put the tiebreak logic in SQL, where
  // the reason for it cannot be explained; here the rule is a handful of lines
  // and says what it does.
  for (const turn of listDialogueForOrder(db, customerId, orderId, limit)) {
    entries.push({
      turn: {
        kind: 'dialogue',
        id: turn.id,
        message: turn.customerMessage,
        question: turn.assistantQuestion,
        itemIds: turn.itemIds,
        createdAt: turn.createdAt,
      },
      // Before the request it led to. In the ask-first flow the question is what
      // the customer answered, so it chronologically precedes the decision row the
      // answer produced; on a same-instant tie the request must not read as if it
      // came first.
      rank: -0.5,
    });
  }
}

function pushUpdates(
  entries: Entry[],
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): void {
  for (const update of listUpdatesForOrder(db, customerId, orderId, limit)) {
    entries.push({
      turn: {
        kind: 'update',
        id: update.id,
        requestId: update.requestId,
        body: update.body,
        createdAt: update.createdAt,
      },
      rank: 1,
    });
  }
}

function pushAgentMessages(
  entries: Entry[],
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): void {
  // The words exchanged with a person. Tied later than the notice below it on a
  // same-instant race: a message and the takeover it follows share a millisecond
  // in a fixed-clock test, so the ordering has to say whose turn is whose.
  for (const message of listAgentMessagesForOrder(db, customerId, orderId, limit)) {
    entries.push({
      turn: {
        kind: 'agent',
        id: message.id,
        sender: message.sender,
        body: message.body,
        createdAt: message.createdAt,
      },
      rank: message.sender === 'customer' ? 0.6 : 0.7,
    });
  }
}

function pushHandoffNotice(entries: Entry[], db: Db, customerId: string): void {
  // The moment the thread changed hands. Rendered as a notice bubble, derived
  // from the takeover row - which is why it is only there while the thread is
  // actually live, and vanishes on hand-back without a row to clean up.
  const active = activeHandoffForCustomer(db, customerId);
  if (active !== null) {
    const body = active.agentId === ESCALATION_AGENT
      ? 'Your request is waiting for a person to review it. The assistant will not reply on their behalf.'
      : 'A customer agent has joined this conversation.';
    entries.push({
      turn: {
        kind: 'handoff',
        id: active.id,
        body,
        createdAt: active.startedAt,
      },
      rank: 0.5,
    });
  }
}

/**
 * Interleaves the thread into one readable order.
 *
 * The `rank` tiebreak is the part worth stating. Two entries can share a
 * timestamp - same millisecond, or a fixed clock in a test - and the ordering
 * still has to match the order the conversation happened in. An update answers
 * the request it follows; a message answers the takeover notice it follows; a
 * customer's words precede the reply to them. Sorting on the timestamp alone
 * would let a reply sort before the question it answers.
 */
function sort(
  entries: readonly Entry[],
): readonly ChatTurn[] {
  return [...entries]
    .sort((a, b) => {
      const when = a.turn.createdAt.localeCompare(b.turn.createdAt);
      return when !== 0 ? when : a.rank - b.rank;
    })
    .map((entry) => entry.turn);
}

/**
 * Total messages per order, for the "3 messages" badge on the order list.
 *
 * Counts the customer's own turns across every table they can appear in, which
 * includes what they said while a person was on the line. A badge that said "1"
 * on a thread the customer can plainly see three messages in is worse than no
 * badge: it is the storefront contradicting itself about whether the customer
 * has been heard from. Agent replies are not counted, because the badge is
 * about the customer's messages, not the length of the transcript.
 */
export function conversationCounts(db: Db, customerId: string): ReadonlyMap<string, number> {
  const requests = queryAll<{ order_id: string; n: number }>(
    db.prepare(
      `SELECT order_id, COUNT(*) AS n
         FROM refund_requests
        WHERE customer_id = ? AND order_id IS NOT NULL
        GROUP BY order_id`,
    ),
    customerId,
  );
  const dialogue = queryAll<{ order_id: string; n: number }>(
    db.prepare(
      `SELECT order_id, COUNT(*) AS n
         FROM shop_dialogue
        WHERE customer_id = ? AND order_id IS NOT NULL
        GROUP BY order_id`,
    ),
    customerId,
  );
  const saidDuringHandoff = queryAll<{ order_id: string; n: number }>(
    db.prepare(
      `SELECT h.order_id, COUNT(*) AS n
         FROM agent_messages m
         JOIN handoffs h ON h.id = m.handoff_id
        WHERE h.customer_id = ? AND h.order_id IS NOT NULL AND m.sender = 'customer'
        GROUP BY h.order_id`,
    ),
    customerId,
  );
  const counts = new Map<string, number>();
  for (const row of [...requests, ...dialogue, ...saidDuringHandoff]) {
    counts.set(row.order_id, (counts.get(row.order_id) ?? 0) + row.n);
  }
  return counts;
}

/**
 * The conversation as the model sees it, for the next message.
 *
 * The assistant holds no state between calls, so every turn ships again as
 * plain `DialogueLine` pairs. The thread above is the customer's view; this is
 * the same rows flattened so a claim can quote an earlier message and grounding
 * can verify that quote against everything the customer actually wrote.
 */
export function transcriptForOrder(
  db: Db,
  customerId: string,
  orderId: string | null,
  now: Date,
  limit: number,
): readonly DialogueLine[] {
  if (orderId === null) {
    return dialogueLines(db, customerId, null, limit);
  }
  const lines: DialogueLine[] = [];
  for (const turn of conversationForOrder(db, customerId, orderId, now, limit)) {
    switch (turn.kind) {
      case 'request':
        lines.push({ role: 'customer', text: turn.message }, { role: 'assistant', text: turn.responseText });
        break;
      case 'dialogue':
        lines.push({ role: 'customer', text: turn.message }, { role: 'assistant', text: turn.question });
        break;
      case 'update':
        lines.push({ role: 'assistant', text: turn.body });
        break;
      // A person's words during a takeover are deliberately *not* part of the
      // model's context. The transcript is the thing grounding verifies quotes
      // against: a quote of the customer's own words. An agent's reply is neither
      // ground truth nor a customer statement, so on hand-back the assistant
      // resumes knowing only what was said before the takeover - which is also
      // the only history it can safely claim to remember.
      case 'agent':
      case 'handoff':
        break;
    }
  }
  return lines.slice(-limit * 2);
}

/**
 * The only context there can be when no order was resolved: the stray-answer
 * dialogue for this customer. There is no `refund_requests` row to quote,
 * because an unresolved order never produces one - the customer may not have
 * answered yet, or may not have an account under this spelling at all.
 */
function dialogueLines(db: Db, customerId: string, orderId: string | null, limit: number): readonly DialogueLine[] {
  const rows = queryAll<{ customer_message: string; assistant_question: string }>(
    db.prepare(
      `SELECT customer_message, assistant_question
         FROM shop_dialogue
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );
  const lines: DialogueLine[] = [];
  for (const row of rows.reverse()) {
    lines.push(
      { role: 'customer', text: row.customer_message },
      { role: 'assistant', text: row.assistant_question },
    );
  }
  return lines;
}

function hydrateTurn(row: TurnRow): ChatTurn {
  return {
    kind: 'request',
    requestId: row.id,
    message: row.message,
    responseText: row.response_text,
    decision: row.decision,
    refundAmountCents: row.refund_amount_cents,
    itemIds: parseIds(row.claim_item_ids_json),
    createdAt: row.created_at,
  };
}

function parseIds(value: string | null): readonly string[] {
  if (value === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string') ? parsed : [];
  } catch {
    return [];
  }
}
