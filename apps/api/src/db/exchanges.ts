import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { findOrder } from './orderRepository.js';

/**
 * Exchanges, kept separate from both returns and money.
 *
 * An exchange is goods coming back AND a replacement going out. A return table
 * can only express the inbound half, and the refund tables only express money,
 * so bolting "we replaced it" onto either would let somebody answer "did the
 * replacement ship?" with a restock row. Here the status track walks the same
 * inbound leg a return does, then keeps going: the replacement leaving is a
 * terminal state of its own, recorded when the warehouse actually hands it over.
 *
 * Like the return ledger, nothing here touches money, and every state change
 * funnels through `advance`, which validates the move against the state table.
 * The difference from a return is the point of closure: `exchange_received`
 * marks that the old goods are back, but the promise the exchange made is not
 * kept until `exchange_replaced`.
 */

import { EXCHANGE_STATUSES, CARRIERS, type ExchangeStatus, type Carrier } from '@refund/shared';

// Re-exported so the rest of the API keeps importing exchange vocabulary from
// one place, whichever module it happens to be reading.
export { EXCHANGE_STATUSES };
export type { ExchangeStatus, Carrier };

/**
 * The only legal moves, shaped like a return's with the replacement leg added.
 *
 * The inbound leg mirrors a return exactly - label, then the box goes - so a
 * warehouse that runs returns can run exchanges without relearning rules. After
 * `exchange_received` the track diverges: the goods are back, and the exchange
 * closes when the replacement goes out (`exchange_replaced`), not when the box
 * arrives. A denial is available from any non-terminal state, exactly as with a
 * return.
 */
export function exchangeTransitions(status: ExchangeStatus): readonly ExchangeStatus[] {
  return TRANSITIONS[status];
}

/** Whether a denial is still available: anything not already closed. */
export function canDenyExchange(status: ExchangeStatus): boolean {
  return TRANSITIONS[status].includes('exchange_denied');
}

const TRANSITIONS: Readonly<Record<ExchangeStatus, readonly ExchangeStatus[]>> = {
  exchange_requested: ['exchange_label_generated', 'exchange_denied'],
  exchange_label_generated: ['exchange_shipped', 'exchange_denied'],
  exchange_shipped: ['exchange_received', 'exchange_denied'],
  exchange_received: ['exchange_replaced', 'exchange_denied'],
  exchange_replaced: [],
  exchange_denied: [],
};

export interface ExchangeRecord {
  readonly id: string;
  /** Null when the exchange began without a refund request to hang off. */
  readonly requestId: string | null;
  readonly orderId: string;
  readonly customerId: string;
  readonly status: ExchangeStatus;
  readonly reason: string;
  /** What the customer asked to receive instead, in the agent's words. */
  readonly replacementNote: string | null;
  readonly trackingNumber: string | null;
  readonly carrier: Carrier | null;
  readonly labelUrl: string | null;
  readonly shippedAt: string | null;
  readonly receivedAt: string | null;
  readonly replacementSentAt: string | null;
  readonly deniedAt: string | null;
  readonly deniedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExchangeItemRecord {
  readonly id: string;
  readonly exchangeId: string;
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly receivedQuantity: number;
  readonly receivedCondition: string | null;
}

/** A line the customer asked to swap, before it is checked against the order. */
interface ExchangeLineRequest {
  readonly itemId: string;
  readonly quantity: number;
}

export class ExchangeLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeLedgerError';
  }
}

interface ExchangeRow {
  readonly id: string;
  readonly request_id: string | null;
  readonly order_id: string;
  readonly customer_id: string;
  readonly status: string;
  readonly reason: string;
  readonly replacement_note: string | null;
  readonly tracking_number: string | null;
  readonly carrier: string | null;
  readonly label_url: string | null;
  readonly shipped_at: string | null;
  readonly received_at: string | null;
  readonly replacement_sent_at: string | null;
  readonly denied_at: string | null;
  readonly denied_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ExchangeItemRow {
  readonly id: string;
  readonly exchange_id: string;
  readonly item_id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
  readonly received_quantity: number;
  readonly received_condition: string | null;
}

interface OrderItemRow {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
}

/**
 * The status column is a CHECK constraint in the schema, so a row that reached
 * the database is always one of these. Narrowing it here keeps the rest of the
 * file from casting a string on every read.
 */
function asStatus(value: string): ExchangeStatus {
  const found = EXCHANGE_STATUSES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new ExchangeLedgerError(`unrecognised exchange status in the database: ${value}`);
  }
  return found;
}

function asCarrier(value: string | null): Carrier | null {
  if (value === null) {
    return null;
  }
  const found = CARRIERS.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new ExchangeLedgerError(`unrecognised carrier in the database: ${value}`);
  }
  return found;
}

function hydrate(row: ExchangeRow): ExchangeRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    status: asStatus(row.status),
    reason: row.reason,
    replacementNote: row.replacement_note,
    trackingNumber: row.tracking_number,
    carrier: asCarrier(row.carrier),
    labelUrl: row.label_url,
    shippedAt: row.shipped_at,
    receivedAt: row.received_at,
    replacementSentAt: row.replacement_sent_at,
    deniedAt: row.denied_at,
    deniedReason: row.denied_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateItem(row: ExchangeItemRow): ExchangeItemRecord {
  return {
    id: row.id,
    exchangeId: row.exchange_id,
    itemId: row.item_id,
    name: row.name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    receivedQuantity: row.received_quantity,
    receivedCondition: row.received_condition,
  };
}

export function findExchangeById(db: Db, id: string): ExchangeRecord | null {
  const row = db.prepare('SELECT * FROM exchanges WHERE id = ?').get(id) as ExchangeRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function findExchangeByRequestId(db: Db, requestId: string): ExchangeRecord | null {
  const row = db.prepare('SELECT * FROM exchanges WHERE request_id = ?').get(requestId) as
    | ExchangeRow
    | undefined;
  return row === undefined ? null : hydrate(row);
}

export interface ListExchangesFilters {
  readonly status?: ExchangeStatus;
  readonly customerId?: string;
  readonly orderId?: string;
  readonly limit?: number;
}

export function listExchanges(db: Db, filters: ListExchangesFilters = {}): readonly ExchangeRecord[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (filters.status !== undefined) {
    conditions.push('status = ?');
    values.push(filters.status);
  }
  if (filters.customerId !== undefined) {
    conditions.push('customer_id = ?');
    values.push(filters.customerId);
  }
  if (filters.orderId !== undefined) {
    conditions.push('order_id = ?');
    values.push(filters.orderId);
  }

  // Bounded so a caller cannot ask for the whole table by omitting a limit.
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const rows = db
    .prepare(`SELECT * FROM exchanges ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, limit) as ExchangeRow[];

  return rows.map(hydrate);
}

export function listExchangeItems(db: Db, exchangeId: string): readonly ExchangeItemRecord[] {
  const rows = db
    .prepare('SELECT * FROM exchange_items WHERE exchange_id = ? ORDER BY name')
    .all(exchangeId) as ExchangeItemRow[];
  return rows.map(hydrateItem);
}

export interface CreateExchangeInput {
  /**
   * The refund request this exchange answers, if there is one.
   *
   * Optional on purpose, exactly as with a return: swapping goods need not begin
   * with a money claim. When it is supplied it is idempotent - one exchange per
   * request - and the same checks that guard a return's request apply: it must
   * be the same customer's, and about the same order.
   *
   * `undefined` is listed alongside `null` on purpose. The project compiles with
   * `exactOptionalPropertyTypes`, under which `requestId?: string | null` does
   * *not* accept an explicit `requestId: undefined` - and a zod schema that
   * makes a field optional still produces one in its output. Writing the union
   * out means callers can spread a parsed body without rebuilding it.
   */
  readonly requestId?: string | null | undefined;
  readonly orderId: string;
  readonly customerId: string;
  readonly items: readonly ExchangeLineRequest[];
  readonly reason: string;
  /** What will be sent instead, in the agent's words. Optional, like a gift note. */
  readonly replacementNote?: string | null | undefined;
  readonly now: Date;
}

/**
 * Opens an exchange against an order.
 *
 * The same three trusts the return ledger refuses to accept from a caller:
 *
 * 1. The order belongs to the named customer - `findOrder` takes the customer
 *    id as part of the lookup, so there is no path that resolves an order by id
 *    alone.
 * 2. A supplied `requestId` is the same customer's and about the same order -
 *    without this, a wrong request could lock the customer out of the partial
 *    unique index, or attach the exchange to money decided against another order.
 * 3. The lines really are on that order, in quantities that were bought.
 *
 * Idempotent on `requestId`, because the trigger is a double-click or a retried
 * call, and two exchanges for one request means two replacements someone has to
 * explain. Name and price are copied from the order row so the record still
 * reads correctly if the catalogue is edited later.
 */
export function createExchange(
  db: Db,
  input: CreateExchangeInput,
): { readonly exchangeRecord: ExchangeRecord; readonly itemRecords: readonly ExchangeItemRecord[] } {
  const requestId = input.requestId ?? null;
  if (requestId !== null) {
    const existing = findExchangeByRequestId(db, requestId);
    if (existing !== null) {
      return { exchangeRecord: existing, itemRecords: listExchangeItems(db, existing.id) };
    }
  }

  assertOrderIsTheirs(db, input);
  assertRequestMatches(db, input, requestId);

  const lines = resolveLines(db, input);
  const id = `EX-${randomUUID()}`;
  const at = input.now.toISOString();
  const replacementNote = input.replacementNote === undefined ? null : input.replacementNote;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO exchanges (
         id, request_id, order_id, customer_id, status, reason, replacement_note,
         tracking_number, carrier, label_url, shipped_at, received_at,
         replacement_sent_at, denied_at, denied_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'exchange_requested', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(id, requestId, input.orderId, input.customerId, input.reason, replacementNote, at, at);

    const insert = db.prepare(
      `INSERT INTO exchange_items (
         id, exchange_id, item_id, name, quantity, unit_price_cents,
         received_quantity, received_condition
       ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    );
    for (const line of lines) {
      insert.run(`EI-${randomUUID()}`, id, line.id, line.name, line.quantity, line.unitPriceCents);
    }
  })();

  const created = findExchangeById(db, id);
  if (created === null) {
    throw new ExchangeLedgerError(`exchange ${id} was missing immediately after being written`);
  }
  return { exchangeRecord: created, itemRecords: listExchangeItems(db, id) };
}

interface ResolvedLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/**
 * The order has to be the named customer's.
 *
 * `findOrder` is the ownership-enforcing reader and it is used on purpose: it
 * builds the query as `WHERE id = ? AND customer_id = ?`, so there is no version
 * of this function that loaded the order first and compared afterwards, where a
 * future edit could drop the second half of the condition.
 *
 * The message does not distinguish "no such order" from "not theirs", because
 * telling the difference turns this into an order-enumeration oracle.
 */
function assertOrderIsTheirs(db: Db, input: CreateExchangeInput): void {
  const owned = findOrder(db, input.customerId, input.orderId, input.now);
  if (owned === null) {
    throw new ExchangeLedgerError(`order ${input.orderId} is not one of yours`);
  }
}

/**
 * A linked refund request has to belong to the same customer and be about the
 * same order, mirroring the return ledger: `requestId` is the idempotency key
 * an exchange is unique on, and every later step that follows it to "the
 * request this exchange answers" must not be able to land on another customer's
 * money or another order's goods.
 */
function assertRequestMatches(db: Db, input: CreateExchangeInput, requestId: string | null): void {
  if (requestId === null) {
    return;
  }
  const row = db
    .prepare('SELECT customer_id AS customerId, order_id AS orderId FROM refund_requests WHERE id = ?')
    .get(requestId) as { customerId: string; orderId: string | null } | undefined;
  if (row === undefined || row.customerId !== input.customerId) {
    throw new ExchangeLedgerError(`refund request ${requestId} is not one of yours`);
  }
  if (row.orderId !== null && row.orderId !== input.orderId) {
    throw new ExchangeLedgerError(
      `refund request ${requestId} is about order ${row.orderId}, not ${input.orderId}`,
    );
  }
}

function resolveLines(db: Db, input: CreateExchangeInput): readonly ResolvedLine[] {
  if (input.items.length === 0) {
    throw new ExchangeLedgerError('an exchange needs at least one item');
  }
  if (input.reason.trim().length === 0) {
    throw new ExchangeLedgerError('an exchange needs a reason');
  }

  const find = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?');
  const lines = input.items.map((item) => {
    const row = find.get(item.itemId, input.orderId) as OrderItemRow | undefined;
    if (row === undefined) {
      throw new ExchangeLedgerError(`${item.itemId} is not a line on order ${input.orderId}`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ExchangeLedgerError(`quantity for ${row.name} must be a whole number of at least 1`);
    }
    if (item.quantity > row.quantity) {
      throw new ExchangeLedgerError(
        `cannot exchange ${item.quantity} of ${row.name}; the order only has ${row.quantity}`,
      );
    }
    return { id: row.id, name: row.name, quantity: item.quantity, unitPriceCents: row.unit_price_cents };
  });

  // Two lines for the same item are collapsed rather than refused: a client that
  // sends [{a,1},{a,1}] means two of a, and the order row is the only thing that
  // can say whether that is allowed.
  const merged = new Map<string, ResolvedLine>();
  for (const line of lines) {
    const seen = merged.get(line.id);
    merged.set(line.id, {
      ...line,
      quantity: (seen?.quantity ?? 0) + line.quantity,
    });
  }
  return [...merged.values()].map((line) => {
    const row = find.get(line.id, input.orderId) as OrderItemRow;
    if (line.quantity > row.quantity) {
      throw new ExchangeLedgerError(
        `cannot exchange ${line.quantity} of ${row.name}; the order only has ${row.quantity}`,
      );
    }
    return line;
  });
}

/**
 * Moves an exchange to `next`, or explains why it cannot.
 *
 * Every status change funnels through here so the state table is the only place
 * that knows what is legal. The caller passes the columns the new status
 * implies; anything that is not part of the transition is rejected rather than
 * quietly dropped, for the same reasons the return ledger does the same.
 */
function advance(
  db: Db,
  exchangeId: string,
  next: ExchangeStatus,
  columns: Readonly<Record<string, string | null>>,
  at: Date,
): ExchangeRecord {
  const current = findExchangeById(db, exchangeId);
  if (current === null) {
    throw new ExchangeLedgerError(`no such exchange: ${exchangeId}`);
  }
  if (!TRANSITIONS[current.status].includes(next)) {
    throw new ExchangeLedgerError(
      `an exchange cannot go from ${current.status} to ${next}`,
    );
  }

  const sets = Object.keys(columns)
    .map((column) => `${column} = ?`)
    .join(', ');
  const values = Object.values(columns);
  db.prepare(
    `UPDATE exchanges SET status = ?, ${sets}, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(next, ...values, at.toISOString(), exchangeId, current.status);

  const updated = findExchangeById(db, exchangeId);
  if (updated === null) {
    throw new ExchangeLedgerError(`exchange ${exchangeId} disappeared mid-transition`);
  }
  return updated;
}

/**
 * Issues a shipping label and moves the exchange to `exchange_label_generated`.
 *
 * `labelUrl` is passed in rather than generated here because buying a label
 * costs money and talks to a carrier: that belongs to the caller, which can
 * charge a card, retry, and report a carrier outage. This function only records
 * the result.
 */
export function generateExchangeLabel(
  db: Db,
  exchangeId: string,
  input: { readonly carrier: Carrier; readonly labelUrl: string; readonly now: Date },
): ExchangeRecord {
  if (!CARRIERS.includes(input.carrier)) {
    throw new ExchangeLedgerError(`unsupported carrier: ${input.carrier}`);
  }
  if (input.labelUrl.trim().length === 0) {
    throw new ExchangeLedgerError('a label needs a URL');
  }
  return advance(
    db,
    exchangeId,
    'exchange_label_generated',
    { carrier: input.carrier, label_url: input.labelUrl },
    input.now,
  );
}

export function markExchangeShipped(
  db: Db,
  exchangeId: string,
  input: { readonly carrier: Carrier; readonly trackingNumber: string; readonly now: Date },
): ExchangeRecord {
  if (input.trackingNumber.trim().length === 0) {
    throw new ExchangeLedgerError('a shipped exchange needs a tracking number');
  }
  const at = input.now.toISOString();
  return advance(
    db,
    exchangeId,
    'exchange_shipped',
    { carrier: input.carrier, tracking_number: input.trackingNumber, shipped_at: at },
    input.now,
  );
}

/**
 * Records the warehouse count, and moves the exchange to `exchange_received`.
 *
 * Like a return receiving, what arrived is recorded per line rather than assumed
 * to match what was sent: "they sent two and one arrived" is the most common
 * goods dispute, and there is nowhere to put that fact if the line is only ever
 * written with the quantity that was requested.
 */
export function markExchangeReceived(
  db: Db,
  exchangeId: string,
  input: {
    readonly lines: readonly {
      readonly itemId: string;
      readonly quantity: number;
      readonly condition: string;
    }[];
    readonly now: Date;
  },
): ExchangeRecord {
  const at = input.now.toISOString();

  db.transaction(() => {
    const record = advance(db, exchangeId, 'exchange_received', { received_at: at }, input.now);

    const update = db.prepare(
      `UPDATE exchange_items
         SET received_quantity = ?, received_condition = ?
       WHERE exchange_id = ? AND item_id = ?`,
    );
    for (const line of input.lines) {
      const changed = update.run(line.quantity, line.condition, record.id, line.itemId);
      if (changed.changes !== 1) {
        throw new ExchangeLedgerError(
          `${line.itemId} is not a line on exchange ${record.id}, so it cannot be received`,
        );
      }
    }
    return record;
  })();

  const updated = findExchangeById(db, exchangeId);
  if (updated === null) {
    throw new ExchangeLedgerError(`exchange ${exchangeId} disappeared after being received`);
  }
  return updated;
}

/**
 * Closes the exchange: the replacement has gone out.
 *
 * The promised half of an exchange is the shipment of what was asked for
 * instead, so this is the terminal state of the happy path. Nothing here moves
 * money or stock - the old goods coming back are a warehouse fact, and restocking
 * them is the same human act it is for a return. What this transition asserts is
 * that the promise the exchange made has been kept, which is the point at which
 * nobody else should be promising the customer another replacement.
 */
export function markExchangeReplaced(
  db: Db,
  exchangeId: string,
  input: { readonly now: Date },
): ExchangeRecord {
  return advance(
    db,
    exchangeId,
    'exchange_replaced',
    { replacement_sent_at: input.now.toISOString() },
    input.now,
  );
}

export function denyExchange(
  db: Db,
  exchangeId: string,
  input: { readonly reason: string; readonly now: Date },
): ExchangeRecord {
  if (input.reason.trim().length === 0) {
    throw new ExchangeLedgerError('a denial needs a reason the customer could be shown');
  }
  const at = input.now.toISOString();
  return advance(
    db,
    exchangeId,
    'exchange_denied',
    { denied_at: at, denied_reason: input.reason },
    input.now,
  );
}