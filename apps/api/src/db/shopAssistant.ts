import type { Db } from './connection.js';
import { queryAll } from './sql.js';

/**
 * The shopping assistant's turns.
 *
 * Separate from `shop_dialogue` on purpose: that table is the refund intake's
 * question-and-answer record, and mixing browsing answers into it would put
 * product cards in front of the grounding check and the policy transcript.
 * These rows are never read by the refund pipeline, the resolver, or the
 * handoff brief - they are the customer's shopping thread, and a reload reads
 * them back so the conversation survives one.
 *
 * `answer_json` freezes what was shown - the sentence and the cards with the
 * prices and stock at the time - so a replayed thread cannot disagree with
 * what the customer acted on.
 */

export interface ShopCard {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly stock: number;
}

export interface ShopOrderSnapshot {
  readonly orderId: string;
  readonly status: string;
  readonly paymentState: string;
  readonly trackingStatus: string;
  readonly totalCents: number;
  readonly items: readonly { readonly name: string; readonly quantity: number; readonly unitPriceCents: number }[];
}

export interface ShopAnswerRecord {
  readonly kind: 'order_status' | 'return_help' | 'product_help';
  readonly answer: string;
  readonly products: readonly ShopCard[];
  readonly orderStatus: ShopOrderSnapshot | null;
}

export interface ShopTurn {
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly customerMessage: string;
  readonly record: ShopAnswerRecord;
}

interface ShopTurnRow {
  readonly id: string;
  readonly created_at: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly customer_message: string;
  readonly answer_json: string;
}

export interface RecordShopTurnInput {
  /** Upfront, so model-attempt rows recorded before the insert name the same turn. */
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly customerMessage: string;
  readonly record: ShopAnswerRecord;
  readonly now: Date;
}

export function recordShopTurn(db: Db, input: RecordShopTurnInput): ShopTurn {
  const turn: ShopTurn = {
    id: input.id,
    createdAt: input.now.toISOString(),
    customerId: input.customerId,
    orderId: input.orderId,
    customerMessage: input.customerMessage,
    record: input.record,
  };
  db.prepare(
    `INSERT INTO shop_assistant_turns
       (id, created_at, customer_id, order_id, customer_message, answer_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(turn.id, turn.createdAt, turn.customerId, turn.orderId, turn.customerMessage, JSON.stringify(turn.record));
  return turn;
}

/** The customer's shopping thread, oldest first. Session-scoped like everything else. */
export function listShopTurns(db: Db, customerId: string, limit: number): readonly ShopTurn[] {
  const rows = queryAll<ShopTurnRow>(
    db.prepare(
      `SELECT id, created_at, customer_id, order_id, customer_message, answer_json
         FROM shop_assistant_turns
        WHERE customer_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    customerId,
    limit,
  );
  const turns: ShopTurn[] = [];
  for (const row of rows) {
    const record = parseRecord(row.answer_json);
    if (record !== null) {
      turns.push({
        id: row.id,
        createdAt: row.created_at,
        customerId: row.customer_id,
        orderId: row.order_id,
        customerMessage: row.customer_message,
        record,
      });
    }
  }
  return turns.reverse();
}

/** A turn this code cannot read is one it must not replay: the row is skipped. */
function parseRecord(json: string): ShopAnswerRecord | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as { kind?: unknown; answer?: unknown; products?: unknown; orderStatus?: unknown };
    if (
      (record.kind !== 'order_status' && record.kind !== 'return_help' && record.kind !== 'product_help') ||
      typeof record.answer !== 'string'
    ) {
      return null;
    }
    return {
      kind: record.kind,
      answer: record.answer,
      products: parseCards(record.products),
      orderStatus: parseSnapshot(record.orderStatus),
    };
  } catch {
    return null;
  }
}

function parseCards(value: unknown): readonly ShopCard[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const cards: ShopCard[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const card = entry as { id?: unknown; name?: unknown; priceCents?: unknown; stock?: unknown };
    if (
      typeof card.id === 'string' &&
      typeof card.name === 'string' &&
      typeof card.priceCents === 'number' &&
      typeof card.stock === 'number'
    ) {
      cards.push({ id: card.id, name: card.name, priceCents: card.priceCents, stock: card.stock });
    }
  }
  return cards;
}

function parseSnapshot(value: unknown): ShopOrderSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const snapshot = value as {
    orderId?: unknown;
    status?: unknown;
    paymentState?: unknown;
    trackingStatus?: unknown;
    totalCents?: unknown;
    items?: unknown;
  };
  if (
    typeof snapshot.orderId !== 'string' ||
    typeof snapshot.status !== 'string' ||
    typeof snapshot.paymentState !== 'string' ||
    typeof snapshot.trackingStatus !== 'string' ||
    typeof snapshot.totalCents !== 'number' ||
    !Array.isArray(snapshot.items)
  ) {
    return null;
  }
  const items: { readonly name: string; readonly quantity: number; readonly unitPriceCents: number }[] = [];
  for (const entry of snapshot.items) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const line = entry as { name?: unknown; quantity?: unknown; unitPriceCents?: unknown };
    if (typeof line.name === 'string' && typeof line.quantity === 'number' && typeof line.unitPriceCents === 'number') {
      items.push({ name: line.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents });
    }
  }
  return {
    orderId: snapshot.orderId,
    status: snapshot.status,
    paymentState: snapshot.paymentState,
    trackingStatus: snapshot.trackingStatus,
    totalCents: snapshot.totalCents,
    items,
  };
}
