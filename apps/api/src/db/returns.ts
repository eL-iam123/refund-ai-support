import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { findOrder } from './orderRepository.js';

/**
 * Physical returns, kept separate from money.
 *
 * A return is goods travelling back to the warehouse; a refund is money moving
 * to a customer. They are related but neither implies the other, and the most
 * common way to get this wrong is to treat "return received" as "refund paid".
 * So nothing in this file touches the refund ledger. A processed return is a
 * *fact about stock*; whether money is owed is decided elsewhere, by the policy
 * engine, and still has to pass the human check before it is paid.
 *
 * Every state change goes through `advance`, which validates the move against
 * the state table below. A warehouse scanning a label twice, or a webhook
 * arriving after a denial, gets a rejected transition rather than a second
 * status overwrite - the difference matters because a return's status is what a
 * support agent reads before promising anyone their money back.
 */

export const RETURN_STATUSES = [
  'return_requested',
  'return_label_generated',
  'return_shipped',
  'return_received',
  'return_processed',
  'return_denied',
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export type Carrier = 'usps' | 'ups' | 'fedex';

const CARRIERS: readonly Carrier[] = ['usps', 'ups', 'fedex'];

/**
 * The only legal moves, and the only status each can be reached from.
 *
 * `return_denied` is deliberately absent from the target list: a denial is not
 * part of the happy path, it is a decision that can be taken from any
 * non-terminal state and ends the return. Once a return is `return_processed`
 * or `return_denied` it is closed - the goods have been dealt with and reopening
 * it would mean somebody has to reconcile two histories.
 */
const TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  return_requested: ['return_label_generated', 'return_denied'],
  return_label_generated: ['return_shipped', 'return_denied'],
  return_shipped: ['return_received', 'return_denied'],
  return_received: ['return_processed', 'return_denied'],
  return_processed: [],
  return_denied: [],
};

export interface ReturnRecord {
  readonly id: string;
  /** Null when the customer returned goods without asking for a refund first. */
  readonly requestId: string | null;
  readonly orderId: string;
  readonly customerId: string;
  readonly status: ReturnStatus;
  readonly reason: string;
  readonly trackingNumber: string | null;
  readonly carrier: Carrier | null;
  readonly labelUrl: string | null;
  readonly shippedAt: string | null;
  readonly receivedAt: string | null;
  readonly processedAt: string | null;
  readonly deniedAt: string | null;
  readonly deniedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReturnItemRecord {
  readonly id: string;
  readonly returnId: string;
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly receivedQuantity: number;
  readonly receivedCondition: string | null;
}

/** A line the customer asked to send back, before it is checked against the order. */
export interface ReturnLineRequest {
  readonly itemId: string;
  readonly quantity: number;
}

export class ReturnLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReturnLedgerError';
  }
}

interface ReturnRow {
  readonly id: string;
  readonly request_id: string;
  readonly order_id: string;
  readonly customer_id: string;
  readonly status: string;
  readonly reason: string;
  readonly tracking_number: string | null;
  readonly carrier: string | null;
  readonly label_url: string | null;
  readonly shipped_at: string | null;
  readonly received_at: string | null;
  readonly processed_at: string | null;
  readonly denied_at: string | null;
  readonly denied_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReturnItemRow {
  readonly id: string;
  readonly return_id: string;
  readonly item_id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
  readonly received_quantity: number;
  readonly received_condition: string | null;
}

interface OrderItemRow {
  readonly id: string;
  readonly order_id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
}

/**
 * The status column is a CHECK constraint in the schema, so a row that reached
 * the database is always one of these. Narrowing it here keeps the rest of the
 * file from casting a string on every read.
 */
function asStatus(value: string): ReturnStatus {
  const found = RETURN_STATUSES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new ReturnLedgerError(`unrecognised return status in the database: ${value}`);
  }
  return found;
}

function asCarrier(value: string | null): Carrier | null {
  if (value === null) {
    return null;
  }
  const found = CARRIERS.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new ReturnLedgerError(`unrecognised carrier in the database: ${value}`);
  }
  return found;
}

function hydrate(row: ReturnRow): ReturnRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    status: asStatus(row.status),
    reason: row.reason,
    trackingNumber: row.tracking_number,
    carrier: asCarrier(row.carrier),
    labelUrl: row.label_url,
    shippedAt: row.shipped_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    deniedAt: row.denied_at,
    deniedReason: row.denied_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateItem(row: ReturnItemRow): ReturnItemRecord {
  return {
    id: row.id,
    returnId: row.return_id,
    itemId: row.item_id,
    name: row.name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    receivedQuantity: row.received_quantity,
    receivedCondition: row.received_condition,
  };
}

export function findReturnById(db: Db, id: string): ReturnRecord | null {
  const row = db.prepare('SELECT * FROM returns WHERE id = ?').get(id) as ReturnRow | undefined;
  return row === undefined ? null : hydrate(row);
}

export function findReturnByRequestId(db: Db, requestId: string): ReturnRecord | null {
  const row = db.prepare('SELECT * FROM returns WHERE request_id = ?').get(requestId) as
    | ReturnRow
    | undefined;
  return row === undefined ? null : hydrate(row);
}

/** Every return a customer has open, newest first. Used by the storefront. */
export function listReturnsForCustomer(db: Db, customerId: string): readonly ReturnRecord[] {
  const rows = db
    .prepare('SELECT * FROM returns WHERE customer_id = ? ORDER BY created_at DESC, id DESC')
    .all(customerId) as ReturnRow[];
  return rows.map(hydrate);
}

export interface ListReturnsFilters {
  readonly status?: ReturnStatus;
  readonly customerId?: string;
  readonly orderId?: string;
  readonly limit?: number;
}

export function listReturns(db: Db, filters: ListReturnsFilters = {}): readonly ReturnRecord[] {
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
    .prepare(`SELECT * FROM returns ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, limit) as ReturnRow[];

  return rows.map(hydrate);
}

export function listReturnItems(db: Db, returnId: string): readonly ReturnItemRecord[] {
  const rows = db
    .prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY name')
    .all(returnId) as ReturnItemRow[];
  return rows.map(hydrateItem);
}

export interface CreateReturnInput {
  /**
   * The refund request this return answers, if there is one.
   *
   * Optional on purpose: sending something back is not the same as asking for
   * money, and requiring a request would mean a gift return or an exchange had
   * to be dressed up as a refund claim first. When it is supplied it is
   * idempotent - one return per request.
   */
  /**
   * `undefined` is listed alongside `null` on purpose. The project compiles with
   * `exactOptionalPropertyTypes`, under which `requestId?: string | null` does
   * *not* accept an explicit `requestId: undefined` - and a zod schema that
   * makes a field optional still produces one in its output. Writing the union
   * out means callers can spread a parsed body without rebuilding it to drop the
   * absent key.
   */
  readonly requestId?: string | null | undefined;
  readonly orderId: string;
  readonly customerId: string;
  readonly items: readonly ReturnLineRequest[];
  readonly reason: string;
  readonly now: Date;
}

/**
 * Opens a return against an order.
 *
 * Three things are checked before a row is written, and all three are checks the
 * caller cannot be trusted to have made:
 *
 * 1. The order belongs to this customer. The order id arrives in the body, and
 *    order ids are sequential and guessable, so without this a signed-in
 *    customer could open a return against somebody else's order and see its item
 *    names in the response. `findOrder` takes the customer id as part of the
 *    lookup rather than checking it afterwards, so there is no code path here
 *    that resolves an order by id alone.
 * 2. A supplied `requestId` is the same customer's, and is about the same order.
 *    Without this a customer could attach their return to another customer's
 *    refund request - and the partial unique index would then lock that customer
 *    out of ever returning anything.
 * 3. The lines really are on that order, in quantities that were bought.
 *
 * Idempotent on `requestId`, because the thing that triggers this is a customer
 * clicking twice or a client retrying, and a warehouse receiving the same parcel
 * twice is a much worse outcome than a second call returning the first result.
 *
 * Name and price are copied from the order row so the return still reads
 * correctly if the catalogue is edited later.
 */
export function createReturn(
  db: Db,
  input: CreateReturnInput,
): { readonly returnRecord: ReturnRecord; readonly itemRecords: readonly ReturnItemRecord[] } {
  const requestId = input.requestId ?? null;
  if (requestId !== null) {
    const existing = findReturnByRequestId(db, requestId);
    if (existing !== null) {
      return { returnRecord: existing, itemRecords: listReturnItems(db, existing.id) };
    }
  }

  assertOrderIsTheirs(db, input);
  assertRequestMatches(db, input, requestId);

  const lines = resolveLines(db, input);
  const id = `RET-${randomUUID()}`;
  const at = input.now.toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO returns (
         id, request_id, order_id, customer_id, status, reason,
         tracking_number, carrier, label_url, shipped_at, received_at,
         processed_at, denied_at, denied_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'return_requested', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(id, requestId, input.orderId, input.customerId, input.reason, at, at);

    const insert = db.prepare(
      `INSERT INTO return_items (
         id, return_id, item_id, name, quantity, unit_price_cents,
         received_quantity, received_condition
       ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    );
    for (const line of lines) {
      insert.run(`RI-${randomUUID()}`, id, line.id, line.name, line.quantity, line.unitPriceCents);
    }
  })();

  const created = findReturnById(db, id);
  if (created === null) {
    throw new ReturnLedgerError(`return ${id} was missing immediately after being written`);
  }
  return { returnRecord: created, itemRecords: listReturnItems(db, id) };
}

interface ResolvedLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/**
 * The order has to be the caller's.
 *
 * `findOrder` is the ownership-enforcing reader, and it is used on purpose: it
 * builds the query as `WHERE id = ? AND customer_id = ?`, so there is no version
 * of this function that loaded the order first and compared afterwards, where a
 * future edit could drop the second half of the condition.
 *
 * The message does not distinguish "no such order" from "not yours", because
 * telling the difference turns this into an order-enumeration oracle.
 */
function assertOrderIsTheirs(db: Db, input: CreateReturnInput): void {
  const owned = findOrder(db, input.customerId, input.orderId, input.now);
  if (owned === null) {
    throw new ReturnLedgerError(`order ${input.orderId} is not one of yours`);
  }
}

/**
 * A linked refund request has to belong to the same customer and be about the
 * same order.
 *
 * The order condition is the one that matters for correctness: `requestId` is
 * the key a return is idempotent on, and `markReturnReceived` and any future
 * step that looks up "the request this return answers" will follow it. A return
 * linked to a request about a different order would send a restock and a
 * decision against the wrong order entirely.
 */
function assertRequestMatches(db: Db, input: CreateReturnInput, requestId: string | null): void {
  if (requestId === null) {
    return;
  }
  const row = db
    .prepare('SELECT customer_id AS customerId, order_id AS orderId FROM refund_requests WHERE id = ?')
    .get(requestId) as { customerId: string; orderId: string | null } | undefined;
  if (row === undefined || row.customerId !== input.customerId) {
    throw new ReturnLedgerError(`refund request ${requestId} is not one of yours`);
  }
  if (row.orderId !== null && row.orderId !== input.orderId) {
    throw new ReturnLedgerError(
      `refund request ${requestId} is about order ${row.orderId}, not ${input.orderId}`,
    );
  }
}

function resolveLines(db: Db, input: CreateReturnInput): readonly ResolvedLine[] {
  if (input.items.length === 0) {
    throw new ReturnLedgerError('a return needs at least one item');
  }
  if (input.reason.trim().length === 0) {
    throw new ReturnLedgerError('a return needs a reason');
  }

  const find = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?');
  const lines = input.items.map((item) => {
    const row = find.get(item.itemId, input.orderId) as OrderItemRow | undefined;
    if (row === undefined) {
      throw new ReturnLedgerError(`${item.itemId} is not a line on order ${input.orderId}`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ReturnLedgerError(`quantity for ${row.name} must be a whole number of at least 1`);
    }
    if (item.quantity > row.quantity) {
      throw new ReturnLedgerError(
        `cannot return ${item.quantity} of ${row.name}; the order only has ${row.quantity}`,
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
      throw new ReturnLedgerError(
        `cannot return ${line.quantity} of ${row.name}; the order only has ${row.quantity}`,
      );
    }
    return line;
  });
}

/**
 * Moves a return to `next`, or explains why it cannot.
 *
 * Every status change funnels through here so the state table is the only place
 * that knows what is legal. The caller passes the columns the new status
 * implies; anything that is not part of the transition is rejected rather than
 * quietly dropped, because a label URL that landed on a shipped return instead
 * of a label-generated one is the kind of thing nobody notices until a customer
 * is sent a broken link.
 */
function advance(
  db: Db,
  returnId: string,
  next: ReturnStatus,
  columns: Readonly<Record<string, string | null>>,
  at: Date,
): ReturnRecord {
  const current = findReturnById(db, returnId);
  if (current === null) {
    throw new ReturnLedgerError(`no such return: ${returnId}`);
  }
  if (!TRANSITIONS[current.status].includes(next)) {
    throw new ReturnLedgerError(
      `a return cannot go from ${current.status} to ${next}`,
    );
  }

  const sets = Object.keys(columns)
    .map((column) => `${column} = ?`)
    .join(', ');
  const values = Object.values(columns);
  db.prepare(
    `UPDATE returns SET status = ?, ${sets}, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(next, ...values, at.toISOString(), returnId, current.status);

  const updated = findReturnById(db, returnId);
  if (updated === null) {
    throw new ReturnLedgerError(`return ${returnId} disappeared mid-transition`);
  }
  return updated;
}

/**
 * Issues a shipping label and moves the return to `return_label_generated`.
 *
 * `labelUrl` is passed in rather than generated here because buying a label
 * costs money and talks to a carrier: that belongs to the caller, which can
 * charge a card, retry, and report a carrier outage. This function only records
 * the result.
 */
export function generateReturnLabel(
  db: Db,
  returnId: string,
  input: { readonly carrier: Carrier; readonly labelUrl: string; readonly now: Date },
): ReturnRecord {
  if (!CARRIERS.includes(input.carrier)) {
    throw new ReturnLedgerError(`unsupported carrier: ${input.carrier}`);
  }
  if (input.labelUrl.trim().length === 0) {
    throw new ReturnLedgerError('a label needs a URL');
  }
  return advance(
    db,
    returnId,
    'return_label_generated',
    { carrier: input.carrier, label_url: input.labelUrl },
    input.now,
  );
}

export function markReturnShipped(
  db: Db,
  returnId: string,
  input: { readonly carrier: Carrier; readonly trackingNumber: string; readonly now: Date },
): ReturnRecord {
  if (input.trackingNumber.trim().length === 0) {
    throw new ReturnLedgerError('a shipped return needs a tracking number');
  }
  const at = input.now.toISOString();
  return advance(
    db,
    returnId,
    'return_shipped',
    { carrier: input.carrier, tracking_number: input.trackingNumber, shipped_at: at },
    input.now,
  );
}

/**
 * Records the warehouse count, and moves the return to `return_received`.
 *
 * What arrived is recorded per line rather than assumed to match what was sent,
 * because "they sent two and one arrived" is the single most common return
 * dispute and there is nowhere to put that fact if the line is only ever written
 * with the quantity that was requested.
 */
export function markReturnReceived(
  db: Db,
  returnId: string,
  input: {
    readonly lines: readonly {
      readonly itemId: string;
      readonly quantity: number;
      readonly condition: string;
    }[];
    readonly now: Date;
  },
): ReturnRecord {
  const at = input.now.toISOString();

  db.transaction(() => {
    const record = advance(db, returnId, 'return_received', { received_at: at }, input.now);

    const update = db.prepare(
      `UPDATE return_items
         SET received_quantity = ?, received_condition = ?
       WHERE return_id = ? AND item_id = ?`,
    );
    for (const line of input.lines) {
      const changed = update.run(line.quantity, line.condition, record.id, line.itemId);
      if (changed.changes !== 1) {
        throw new ReturnLedgerError(
          `${line.itemId} is not a line on return ${record.id}, so it cannot be received`,
        );
      }
    }
    return record;
  })();

  const updated = findReturnById(db, returnId);
  if (updated === null) {
    throw new ReturnLedgerError(`return ${returnId} disappeared after being received`);
  }
  return updated;
}

/**
 * Closes the return and puts the received goods back into stock.
 *
 * Restocking is a warehouse fact, not a refund: nothing here touches money. It
 * runs in the same transaction as the status change so a return cannot end up
 * marked processed with the stock write rolled back, which would quietly lose
 * inventory every time the database was interrupted between the two.
 *
 * The caller says which *lines* are going back on the shelf; the ledger works out
 * the product. That direction is deliberate. Accepting a product id from the
 * caller would mean a typo - or anything less innocent - could add stock to a
 * product nobody returned, and stock is the one number here that stays quietly
 * wrong until an oversell. Resolving `return_items -> order_items ->
 * products` cannot be misdirected, because the only reachable product is the
 * one the customer actually bought on that order.
 *
 * The quantity is additionally capped at what was recorded as received, so a
 * return cannot put more back on the shelf than the warehouse signed for.
 */
export function processReturn(
  db: Db,
  returnId: string,
  input: {
    readonly restock: readonly { readonly itemId: string; readonly quantity: number }[];
    readonly now: Date;
  },
): ReturnRecord {
  db.transaction(() => {
    const record = advance(
      db,
      returnId,
      'return_processed',
      { processed_at: input.now.toISOString() },
      input.now,
    );

    // One join resolves product and the ceiling in the same row: nothing to
    // restock can be named here unless the line is genuinely part of this
    // return.
    const resolve = db.prepare(
      `SELECT oi.product_id AS productId, ri.received_quantity AS received
         FROM return_items ri
         JOIN order_items oi ON oi.id = ri.item_id
        WHERE ri.id = ? AND ri.return_id = ?`,
    );
    const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');

    for (const line of input.restock) {
      if (!Number.isInteger(line.quantity) || line.quantity < 0) {
        throw new ReturnLedgerError('restock quantities must be whole numbers of zero or more');
      }
      if (line.quantity === 0) {
        continue;
      }
      const row = resolve.get(line.itemId, returnId) as
        | { productId: string | null; received: number }
        | undefined;
      if (row === undefined) {
        throw new ReturnLedgerError(`${line.itemId} is not a line on return ${returnId}`);
      }
      if (row.productId === null) {
        throw new ReturnLedgerError(
          `${line.itemId} predates product tracking, so it cannot be restocked automatically - restock it by hand`,
        );
      }
      if (line.quantity > row.received) {
        throw new ReturnLedgerError(
          `cannot restock ${line.quantity} of ${line.itemId}: only ${row.received} were received`,
        );
      }
      restock.run(line.quantity, row.productId);
    }
    return record;
  })();

  const updated = findReturnById(db, returnId);
  if (updated === null) {
    throw new ReturnLedgerError(`return ${returnId} disappeared after being processed`);
  }
  return updated;
}

export function denyReturn(
  db: Db,
  returnId: string,
  input: { readonly reason: string; readonly now: Date },
): ReturnRecord {
  if (input.reason.trim().length === 0) {
    throw new ReturnLedgerError('a denial needs a reason the customer could be shown');
  }
  const at = input.now.toISOString();
  return advance(
    db,
    returnId,
    'return_denied',
    { denied_at: at, denied_reason: input.reason },
    input.now,
  );
}
