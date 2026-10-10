/**
 * Which order, and which items, a request is actually about.
 *
 * Resolution is deterministic and ordered by how much the customer told us. The
 * model is not consulted here at all: an order reference is either in the
 * request, in the customer's message, or inferable from the products they
 * actually bought - and all three are facts we can check. Leaving a model in
 * this loop would mean the one step that decides *what money is about* was the
 * one step we could not explain.
 *
 * Nothing here approves or denies. It produces the order and the item scope,
 * and the policy engine does the rest.
 */

import type { Db } from '../db/connection.js';
import type { CustomerRecord, OrderItemRecord, OrderRecord } from '../db/records.js';
import { findOrder, listOrdersForCustomer } from '../db/orderRepository.js';
import { formatCents } from '../lib/money.js';
import {
  confidentMatch,
  describeMatch,
  matchOrders,
  scopeItems,
} from './keywords.js';

/**
 * How the order was found. Recorded in the trace, because "the customer told
 * us" and "we worked it out from their history" are different claims and a
 * dispute turns on which one applies.
 */
type OrderBasis = 'supplied' | 'only_order' | 'matched_history' | 'unresolved';

export interface Identification {
  readonly order: OrderRecord | null;
  readonly basis: OrderBasis;
  /** Orders still in contention, so an escalation can say how bad the ambiguity is. */
  readonly candidates: number;
  /** Products the message points at. The ceiling on any partial refund. */
  readonly items: readonly OrderItemRecord[];
  /** Audit wording. Explains the choice without re-deriving it. */
  readonly evidence: string;
}

/** An order id typed by the customer, e.g. "please refund ORD-1003". */
const ORDER_REFERENCE = /\bORD-[A-Z0-9]+\b/i;

/**
 * Resolves the order from the request, the message, and the customer's history.
 *
 * The order of the tiers is the whole design. An explicit reference is trusted -
 * but only ever as far as ownership, which the lookup enforces. A single order
 * on file needs no inference. Only when the customer has a real choice to make
 * do we read their message, and then only a unique match is accepted.
 *
 * `selectedItemIds` is the storefront's item picker. It says which *lines* are in
 * dispute, and when it is present it replaces the keyword matcher, which is the
 * point: a tick is unambiguous where a word is not. It names the order too, but
 * only as a last resort - and only where one order holds the whole selection,
 * since two baskets sharing a ticked line means the customer has not said which
 * one this is about.
 */
export function identifyOrder(
  db: Db,
  customer: CustomerRecord,
  requestedId: string | null,
  message: string,
  now: Date,
  selectedItemIds: readonly string[] = [],
): Identification {
  const found = resolveOrder(db, customer, requestedId, message, now, selectedItemIds);
  // Which *items* are in dispute comes from the message, always - even when the
  // order was named outright. Knowing the order answers "where does this land",
  // not "what is being claimed": a customer who names ORD-1001 and then says
  // "the television is broken" has claimed one item of four, and reading the
  // whole basket as the claim is how a $200 repair becomes a $400 refund.
  return withScope(found, message, selectedItemIds);
}

/** Attaches the item scope implied by the message - or by the picker - to any identification. */
function withScope(
  found: Omit<Identification, 'items'>,
  message: string,
  selectedItemIds: readonly string[],
): Identification {
  if (found.order === null) {
    return { ...found, items: [] };
  }
  const picked = selectedItems(found.order, selectedItemIds);
  if (picked.length > 0) {
    return {
      ...found,
      items: picked,
      evidence: `${found.evidence}; customer selected ${picked.length} of ${found.order.items.length} item(s) by id`,
    };
  }
  return { ...found, items: disputeItems(found.order, message) };
}

/**
 * The ticked lines that are genuinely on this order.
 *
 * Ids that belong to nothing on the order are dropped rather than looked up
 * elsewhere. A selection is a claim about *these* items, so an id from another
 * basket is not a selection that could not be resolved - it is a selection that
 * cannot be honoured, and honouring it by widening would refund something the
 * customer did not tick.
 */
function selectedItems(
  order: OrderRecord,
  selectedItemIds: readonly string[],
): readonly OrderItemRecord[] {
  if (selectedItemIds.length === 0) {
    return [];
  }
  const wanted = new Set(selectedItemIds);
  return order.items.filter((item) => wanted.has(item.id));
}

/**
 * A selected order stands, unless the message is about something that is
 * demonstrably not in it.
 *
 * The test is deliberately narrow. Customers legitimately buy the same product
 * twice, so "espresso machine" legitimately matches two orders and that is not a
 * conflict when one of them is the order they selected. What is a conflict is
 * naming a product that is in *no* item of the selected order while pointing
 * squarely at one that is in a different order - a customer looking at one
 * basket and describing another. Refunding the selected basket then hands back
 * money for items nobody disputed.
 *
 * A ticked selection short-circuits the whole check. The customer pointed at the
 * lines themselves, so a message that happens to name something in another order
 * is not evidence they meant that order - it is evidence they also have one.
 */
function checkAgreement(
  db: Db,
  customer: CustomerRecord,
  order: OrderRecord,
  message: string,
  now: Date,
  selectedItemIds: readonly string[] = [],
): Omit<Identification, 'items'> {
  if (selectedItems(order, selectedItemIds).length > 0) {
    return supplied(order);
  }
  if (scopeItems(matchOrders([order], message)).length > 0) {
    return supplied(order);
  }
  const elsewhere = matchOrders(
    listOrdersForCustomer(db, customer.id, now).filter((each) => each.id !== order.id),
    message,
  ).matches;
  if (elsewhere.length === 0) {
    return supplied(order);
  }
  return {
    order: null,
    basis: 'unresolved',
    candidates: elsewhere.length,
    evidence:
      `order ${order.id} was selected but the message describes ${elsewhere
        .map((match) => match.order.id)
        .join(', ')} - needs a person`,
  };
}

/** Products in this order that the customer's own words point at. */
function disputeItems(order: OrderRecord, message: string): readonly OrderItemRecord[] {
  return scopeItems(matchOrders([order], message), message);
}

function resolveOrder(
  db: Db,
  customer: CustomerRecord,
  requestedId: string | null,
  message: string,
  now: Date,
  selectedItemIds: readonly string[] = [],
): Omit<Identification, 'items'> {
  if (requestedId !== null) {
    // Ownership is enforced inside the lookup. An order that exists but belongs
    // to someone else is indistinguishable here from one that does not exist,
    // which is deliberate: confirming it would turn this endpoint into an
    // order-id oracle.
    const order = findOrder(db, customer.id, requestedId, now);
    if (order === null) {
      return unresolved(1, `no order ${requestedId} on file for this customer`);
    }
    return checkAgreement(db, customer, order, message, now, selectedItemIds);
  }

  const orders = listOrdersForCustomer(db, customer.id, now);
  if (orders.length === 0) {
    return unresolved(0, 'this customer has no orders on file');
  }

  const only = orders.length === 1 ? orders[0] : undefined;
  if (only !== undefined) {
    return {
      order: only,
      basis: 'only_order',
      candidates: 1,
      evidence: `order ${only.id} is the only order on file`,
    };
  }

  // A picker can stand in for an order reference as well as for item words, but
  // only when one order holds the whole selection.
  const ticked = orderOwningAll(orders, selectedItemIds);
  if (ticked !== null) {
    return {
      order: ticked,
      basis: 'supplied',
      candidates: 1,
      evidence: `order ${ticked.id} identified from the ${selectedItemIds.length} item(s) the customer selected`,
    };
  }

  return identifyFromHistory(orders, message);
}

/**
 * The one order that holds every ticked line, or null when there is not one.
 *
 * Ambiguity is left ambiguous. Two orders that both contain a ticked id mean the
 * customer has said nothing about which order this is about, and resolving that
 * by picking the newest would refund from whichever basket happened to be
 * convenient - so a tie still goes down the ordinary route, to a person.
 */
function orderOwningAll(
  orders: readonly OrderRecord[],
  selectedItemIds: readonly string[],
): OrderRecord | null {
  if (selectedItemIds.length === 0) {
    return null;
  }
  const holders = orders.filter(
    (order) => selectedItems(order, selectedItemIds).length === selectedItemIds.length,
  );
  return holders.length === 1 ? (holders[0] ?? null) : null;
}

/**
 * The customer has several orders and did not say which. Match their own words
 * against the products they bought.
 *
 * A reference typed in the message is honoured, because it is still the customer
 * telling us. Otherwise product words decide, and a tie goes to a person.
 */
function identifyFromHistory(
  orders: readonly OrderRecord[],
  message: string,
): Omit<Identification, 'items'> {
  const typed = ORDER_REFERENCE.exec(message);
  if (typed !== null) {
    return byReference(orders, typed[0].toUpperCase());
  }

  const result = matchOrders(orders, message);
  // A message that names products from different orders is a choice the
  // customer has to make, even if one product has an extra matching modifier
  // such as "floor". A weighted keyword lead must not erase an explicitly
  // mentioned second product: ask which order instead of attaching the whole
  // complaint to the stronger lexical match.
  if (result.matches.length > 1) {
    return unresolved(
      result.matches.length,
      `message describes products from multiple orders: ${result.matches.map((match) => match.order.id).join(', ')} - needs clarification`,
    );
  }
  const match = confidentMatch(result);
  return {
    order: match?.order ?? null,
    basis: match === null ? 'unresolved' : 'matched_history',
    candidates: result.matches.length,
    evidence: describeMatch(match, result),
  };
}

function supplied(order: OrderRecord): Omit<Identification, 'items'> {
  return {
    order,
    basis: 'supplied',
    candidates: 1,
    evidence: `order ${order.id} supplied in the request`,
  };
}

/** An order id the customer typed, honoured only if it is genuinely theirs. */
function byReference(
  orders: readonly OrderRecord[],
  wanted: string,
): Omit<Identification, 'items'> {
  const named = orders.find((order) => order.id.toUpperCase() === wanted);
  if (named === undefined) {
    return unresolved(1, `${wanted} is not one of this customer's orders`);
  }
  return {
    order: named,
    basis: 'matched_history',
    candidates: 1,
    evidence: `order ${named.id} named in the message`,
  };
}

function unresolved(candidates: number, reason: string): Omit<Identification, 'items'> {
  return { order: null, basis: 'unresolved', candidates, evidence: reason };
}

/**
 * The ceiling on an automatic refund, in cents.
 *
 * When the request points at specific products, only those products can be paid
 * for. A customer whose television is cracked is owed the television, and
 * refunding the lamp they are keeping is a loss the business absorbs and the
 * customer did not ask for.
 *
 * Returns null when the message identifies nothing, which means the customer
 * made a whole-order claim and the ordinary eligible amount applies.
 */
export function disputeCeiling(
  identification: Identification,
  eligibleItems: readonly OrderItemRecord[],
): number | null {
  if (identification.items.length === 0 || identification.order === null) {
    return null;
  }
  const disputed = new Set(identification.items.map((item) => item.id));
  const inScope = eligibleItems.filter((item) => disputed.has(item.id));
  // A named item that is blocked by policy has a zero ceiling, not a missing
  // ceiling. Treating it as null would widen "the final-sale coat" to every
  // other eligible line in the basket - the exact cross-item refund failure the
  // picker is meant to prevent.
  return inScope.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);
}

/** Audit wording for a capped approval, or null when the cap does not apply. */
export function describeCeiling(
  ceiling: number | null,
  eligibleAmountCents: number,
): string | null {
  if (ceiling === null || ceiling >= eligibleAmountCents) {
    return null;
  }
  return `limited to ${formatCents(ceiling)}: the request names specific products, so the untouched remainder of the order is not refunded`;
}
