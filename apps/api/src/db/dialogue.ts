import type { Db } from './connection.js';
import { queryAll } from './sql.js';
import { randomUUID } from 'node:crypto';

/**
 * The assistant's clarifying questions and the customer messages they answered.
 *
 * This is the transcript of the messenger half of the job. When the assistant
 * asks a question instead of submitting a claim, the exchange lands here: the
 * customer's own words and the question that was published back to them. Two
 * columns because a question never exists without the message it answers.
 *
 * It is not a decision, it is not a `refund_requests` row, and it must not read
 * like one: nothing here was resolved. The `conversationForOrder` thread keeps
 * these rows between `request` turns so the customer reads one seamless
 * conversation and the model reads one seamless context, while the admin drawer
 * and the queue only ever see real requests.
 */

export interface DialogueTurn {
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly customerMessage: string;
  readonly assistantQuestion: string;
  readonly itemIds: readonly string[];
}

interface DialogueRow {
  readonly id: string;
  readonly created_at: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly customer_message: string;
  readonly assistant_question: string;
  readonly item_ids_json: string;
}

export interface RecordDialogueInput {
  readonly customerId: string;
  readonly orderId: string | null;
  readonly customerMessage: string;
  readonly assistantQuestion: string;
  readonly itemIds: readonly string[];
  readonly now: Date;
}

export function recordDialogueTurn(db: Db, input: RecordDialogueInput): DialogueTurn {
  const turn: DialogueTurn = {
    id: `DLG-${randomUUID()}`,
    createdAt: input.now.toISOString(),
    customerId: input.customerId,
    orderId: input.orderId,
    customerMessage: input.customerMessage,
    assistantQuestion: input.assistantQuestion,
    itemIds: input.itemIds,
  };
  db.prepare(
    `INSERT INTO shop_dialogue (id, created_at, customer_id, order_id, customer_message, assistant_question, item_ids_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    turn.createdAt,
    turn.customerId,
    turn.orderId,
    turn.customerMessage,
    turn.assistantQuestion,
    JSON.stringify(turn.itemIds),
  );
  return turn;
}

/**
 * The dialogue belonging to one order's thread, oldest first.
 *
 * Scoped by customer as well as order, on the same reasoning as the request
 * history beside it: either condition is sufficient, and a filter that is the
 * only defence is one refactor away from not being one.
 */
export function listDialogueForOrder(
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): readonly DialogueTurn[] {
  const rows = queryAll<DialogueRow>(
    db.prepare(
      `SELECT id, created_at, customer_id, order_id, customer_message, assistant_question, item_ids_json
         FROM shop_dialogue
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );
  return rows.map(hydrate).reverse();
}

/**
 * Attach a customer's unanswered clarify turns to the order their answer
 * resolved to.
 *
 * When the assistant asks "which order?" there is no order yet, so the turn is
 * stored with `order_id` null. The customer's answer then resolves one - and
 * that resolution is ownership: the question belongs to the order it led to.
 * Adopting the orphaned turns keeps the order's thread and its model transcript
 * continuous, so the answer is decided against the question instead of being
 * read as a fresh, contextless message.
 *
 * Only null-order rows move. A turn already attached to an order is left alone.
 */
export function adoptDialogueToOrder(db: Db, customerId: string, orderId: string): void {
  db.prepare(
    `UPDATE shop_dialogue
        SET order_id = ?
      WHERE id = (
        SELECT id FROM shop_dialogue
         WHERE customer_id = ? AND order_id IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1
      )`,
  ).run(orderId, customerId);
}

/** The final thread turn, when it is an unanswered assistant clarification. */
export function pendingDialogueItemIds(
  db: Db,
  customerId: string,
  orderId: string,
): readonly string[] {
  const row = db.prepare(
    `SELECT item_ids_json
       FROM shop_dialogue
      WHERE customer_id = ? AND order_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
  ).get(customerId, orderId) as { item_ids_json: string } | undefined;
  return row === undefined ? [] : parseItemIds(row.item_ids_json);
}

function hydrate(row: DialogueRow): DialogueTurn {
  return {
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    orderId: row.order_id,
    customerMessage: row.customer_message,
    assistantQuestion: row.assistant_question,
    itemIds: parseItemIds(row.item_ids_json),
  };
}

function parseItemIds(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string') ? parsed : [];
  } catch {
    return [];
  }
}