import type { Db } from '../db/connection.js';
import { formatCents } from '../lib/money.js';
import type { ItemPickerConfig } from '../config/env.js';
import type { OrderItemRecord, OrderRecord } from '../db/records.js';
import type { GateResult } from '../policy/gates.js';
import type { Identification } from './identifyOrder.js';

/**
 * When to ask the customer which line their claim is about.
 *
 * The picker is not an interface question, it is a trust question, and the answer
 * is fixed before any of this code runs:
 *
 * **The model may ask. Only the customer may answer.** `itemIds` are not a
 * preference - they are the dispute ceiling, because `disputeCeiling()` builds it
 * from the resolved lines, and that caps what an approval can pay. If a model
 * could pick, the model would be choosing how much money leaves the till, which
 * is the thing ADR 0001 exists to prevent. So the `ask_which_items` tool carries
 * candidate ids as *hints*, they are re-validated against the resolved order here,
 * and the scope that counts arrives as an ordinary `itemIds` on the customer's
 * next message. There is deliberately no code path where model output becomes
 * scope.
 *
 * Two consequences worth stating, because they are the whole design:
 *
 *  - The offer can only ever **narrow** a claim. Picking nothing, or picking
 *    "the whole order", leaves it whole - the same thing that happens today when
 *    the matcher cannot tell which line was meant.
 *  - This module never decides anything. It returns a list of lines to offer or
 *    `null`, and every gate below can only *withhold* an offer. There is no
 *    condition under which adding an offer would change a decision, because the
 *    offer changes nothing until a human clicks.
 */

/** One line as the picker shows it. */
export interface ItemChoice {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Set when this line already has a request or an open escalation. */
  readonly reported: boolean;
}

export interface ItemPickerOffer {
  readonly orderId: string;
  readonly items: readonly ItemChoice[];
  /** Lines the model nominated, already filtered. Empty when it nominated none. */
  readonly suggested: readonly string[];
}

/**
 * The off-by-default bounds, used when a caller supplies none.
 *
 * On by default because the layer is inert without a click, but exported so a
 * test that does not care about it gets the production behaviour rather than
 * something invented for the test.
 */
export const DEFAULT_ITEM_PICKER: ItemPickerConfig = {
  enabled: true,
  minCents: 2_500,
  maxOffersPerThread: 1,
};

/**
 * The whole decision, in one call.
 *
 * `request` is what the model asked for, if anything, and it is a hint: the
 * conditions below decide whether an offer happens at all, so a model that asks
 * on every turn cannot produce a picker on every turn.
 */
export function itemPickerOffer(input: {
  readonly db: Db;
  readonly customerId: string;
  readonly order: OrderRecord | null;
  readonly identification: Identification;
  readonly gates: GateResult;
  readonly injectionDetected: boolean;
  readonly handoffActive: boolean;
  readonly request: { readonly candidates: readonly string[] } | null;
  readonly config: ItemPickerConfig;
}): ItemPickerOffer | null {
  const { config } = input;
  if (!config.enabled) {
    return null;
  }
  if (input.order === null || input.gates.terminal || input.injectionDetected || input.handoffActive) {
    return null;
  }
  if (offersAlreadyMade(input.db, input.order.id, config.maxOffersPerThread)) {
    return null;
  }
  // A resolved scope needs no question, and an order of one line has nothing to
  // choose between.
  const choices = selectable(input, input.order, input.request);
  if (input.identification.items.length > 0 || choices.length === 0) {
    return null;
  }
  // Below the floor the choice cannot change what is paid, so asking would be a
  // form field in disguise.
  if (input.gates.eligibleAmountCents < config.minCents) {
    return null;
  }

  return { orderId: input.order.id, items: choices, suggested: suggestedIds(input.order, input.request) };
}

/** The lines a picker may show: those with nothing decided against them yet. */
function selectable(
  input: { readonly db: Db; readonly customerId: string },
  order: OrderRecord | null,
  request: { readonly candidates: readonly string[] } | null,
): readonly ItemChoice[] {
  if (order === null) {
    return [];
  }
  const reported = new Set(reportedItemIds(input.db, input.customerId, order.id));
  const choices = order.items
    .filter((item) => !reported.has(item.id))
    .map((item) => toChoice(item, !reported.has(item.id)));
  const nominated = new Set(request?.candidates ?? []);
  // When the model names candidates, those are what to put in front of the
  // customer: it read the message and knows which lines it could not tell apart.
  const narrowed = choices.filter((choice) => nominated.has(choice.itemId));
  return narrowed.length > 0 ? narrowed : choices;
}

/**
 * Which of the offered lines the model actually meant.
 *
 * Re-validated against the order rather than trusted, on the same rule
 * `identifyOrder` applies to ticked ids: an id that is not on this order is
 * dropped, because resolving it somewhere else would offer a line from a
 * different basket. An empty result simply means "no suggestion", which is the
 * same as the model having asked with nothing to say.
 */
function suggestedIds(
  order: OrderRecord | null,
  request: { readonly candidates: readonly string[] } | null,
): readonly string[] {
  if (order === null || request === null) {
    return [];
  }
  const onThisOrder = new Set(order.items.map((item) => item.id));
  return request.candidates.filter((itemId) => onThisOrder.has(itemId));
}

function toChoice(item: OrderItemRecord, reported: boolean): ItemChoice {
  return {
    itemId: item.id,
    name: item.name,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    reported,
  };
}

/**
 * Lines already carrying a request or an open escalation.
 *
 * The same set the storefront derives from the thread's decided turns, read from
 * the same column, so the server's picker and the client's list of disabled
 * lines can never disagree about what is still available. What makes a line
 * unavailable is that a claim already exists against it - including one still
 * waiting on a person.
 */
export function reportedItemIds(db: Db, customerId: string, orderId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT claim_item_ids_json
         FROM refund_requests
        WHERE order_id = ? AND customer_id = ?`,
    )
    .all(orderId, customerId) as { claim_item_ids_json: string }[];
  return [...new Set(rows.flatMap((row) => parseItemIds(row.claim_item_ids_json)))];
}

function parseItemIds(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // A row this code cannot read is a row it must not offer on.
    return [];
  }
}

/**
 * Whether this thread has already been offered the picker.
 *
 * Counted from the stored offers on the order's thread, which is what makes the
 * bound survive a reload, a second device and a resumed conversation. An
 * unresolved scope simply stays unresolved and escalates, which is the right
 * destination for an ambiguity nobody will settle.
 */
function offersAlreadyMade(db: Db, orderId: string, maxOffers: number): boolean {
  if (maxOffers <= 0) {
    return true;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM shop_dialogue
        WHERE order_id = ? AND assistant_offer_json IS NOT NULL`,
    )
    .get(orderId) as { n: number };
  return row.n >= maxOffers;
}

/** What an operator sees when the floor is above the order: a reason, not a number. */
export function pickerSkippedReason(gates: GateResult, config: ItemPickerConfig): string {
  return `not offered: eligible ${formatCents(gates.eligibleAmountCents)} is below the ${formatCents(config.minCents)} floor`;
}