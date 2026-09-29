import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { ShopAuthError } from './auth.js';

/**
 * Catalogue and checkout.
 *
 * Checkout writes into the same `orders` and `order_items` tables the refund
 * engine already reads, so a shopper can buy something and then report it
 * faulty without any synchronisation step or second source of truth. That is the
 * entire reason the storefront is not a separate service.
 *
 * Nothing here marks an order delivered, refunded or paid-in-full: those are
 * operational facts set by fulfilment and payments, and a checkout has no
 * business inventing them.
 */

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly description: string;
  readonly priceCents: number;
  readonly finalSale: boolean;
  readonly digital: boolean;
  readonly isSubscription: boolean;
  readonly stock: number;
  /** Which refund rule this item is useful for testing, if any. */
  readonly testsPolicy: string | null;
  readonly imageHue: number;
}

interface ProductRow {
  id: string;
  name: string;
  blurb: string;
  description: string;
  price_cents: number;
  final_sale: number;
  digital: number;
  is_subscription: number;
  stock: number;
  tests_policy: string | null;
  image_hue: number;
}

export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface ShopOrder {
  readonly id: string;
  readonly placedAt: string;
  readonly status: string;
  readonly paymentState: string;
  readonly trackingStatus: string;
  readonly totalCents: number;
  readonly items: readonly {
    /** The order line. A return is filed against this, not against a product. */
    readonly itemId: string;
    /** Null when the line's product has since left the catalogue. */
    readonly productId: string | null;
    readonly name: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }[];
}

const MAX_QUANTITY = 10;

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    blurb: row.blurb,
    description: row.description,
    priceCents: row.price_cents,
    finalSale: row.final_sale === 1,
    digital: row.digital === 1,
    isSubscription: row.is_subscription === 1,
    stock: row.stock,
    testsPolicy: row.tests_policy,
    imageHue: row.image_hue,
  };
}

export function listProducts(db: Db): readonly Product[] {
  const rows = db.prepare('SELECT * FROM products ORDER BY rowid').all() as ProductRow[];
  return rows.map(toProduct);
}

export function findProduct(db: Db, productId: string): Product | null {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as ProductRow | undefined;
  return row === undefined ? null : toProduct(row);
}

/**
 * Registers a catalogue item. Used by the seed, and by nothing at runtime.
 *
 * On conflict the descriptive columns are refreshed, so a price or copy change
 * reaches an existing database, but `stock` is deliberately left alone. Stock is
 * live state that checkouts have already decremented: restoring it on every boot
 * would let the shop sell the same unit twice, and the refund engine would then
 * be reasoning about orders for inventory that was never there. To restock a
 * demo, delete the database.
 */
export function insertProduct(db: Db, product: Product): void {
  db.prepare(
    `INSERT INTO products (
       id, name, blurb, description, price_cents, final_sale, digital,
       is_subscription, stock, tests_policy, image_hue
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, blurb = excluded.blurb, description = excluded.description,
       price_cents = excluded.price_cents, final_sale = excluded.final_sale,
       digital = excluded.digital, is_subscription = excluded.is_subscription,
       tests_policy = excluded.tests_policy, image_hue = excluded.image_hue`,
  ).run(
    product.id,
    product.name,
    product.blurb,
    product.description,
    product.priceCents,
    product.finalSale ? 1 : 0,
    product.digital ? 1 : 0,
    product.isSubscription ? 1 : 0,
    product.stock,
    product.testsPolicy,
    product.imageHue,
  );
}

/**
 * Validates a cart before any database work, so a malformed request costs
 * nothing.
 *
 * Takes `unknown` on purpose. The zod schema at the route already narrowed this,
 * but checkout is the function that decides what a purchase costs, so it checks
 * the shape it was actually handed rather than trusting a type that a future
 * caller could route around.
 */
function normaliseLines(input: unknown): readonly CartLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ShopAuthError('your cart is empty');
  }
  if (input.length > 25) {
    throw new ShopAuthError('too many different items in one order');
  }
  return input.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ShopAuthError('each cart line must be an object');
    }
    const line = entry as Record<string, unknown>;
    const productId = line.productId;
    const quantity = line.quantity;
    if (typeof productId !== 'string' || productId.length === 0) {
      throw new ShopAuthError('each cart line needs a productId');
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new ShopAuthError(`quantity must be a whole number between 1 and ${MAX_QUANTITY}`);
    }
    return { productId, quantity };
  });
}

/**
 * Merges repeated lines for the same product.
 *
 * A cart can arrive with the same productId twice - two clicks, a retried
 * request, a hand-built payload. Checking each line against the stock it sees
 * independently means two lines of 1 pass against a stock of 1, and the order
 * ships 2 of 1: stock goes negative and the shop sells what it does not have.
 * Collapsing to one line per product first makes the stock check meaningful,
 * and the total quantity is then bounded by MAX_QUANTITY rather than by the
 * number of lines.
 */
function mergeLines(lines: readonly CartLine[]): readonly CartLine[] {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    const combined = (quantities.get(line.productId) ?? 0) + line.quantity;
    if (combined > MAX_QUANTITY) {
      throw new ShopAuthError(`too many of one product in one order (max ${MAX_QUANTITY})`);
    }
    quantities.set(line.productId, combined);
  }
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

/**
 * Turns a cart into an order.
 *
 * Prices are read from the database inside the transaction, never from the
 * request: a client that could name its own total would be a discount bug, and
 * a client that could name a price for a product it is not buying would be a
 * theft bug.
 */
export function checkout(db: Db, customerId: string, lines: readonly CartLine[], now: Date): ShopOrder {
  const requested = mergeLines(normaliseLines(lines));
  const orderId = `ORD-${randomUUID()}`;

  return db.transaction((): ShopOrder => {
    const priced = priceCart(db, requested);
    insertOrder(db, orderId, customerId, priced, now);
    // Collected as they are inserted, because the line id is generated here and
    // the response has to name the same rows the next return request will.
    const items = priced.map((line) => insertOrderItem(db, orderId, line));

    return {
      id: orderId,
      placedAt: now.toISOString(),
      status: 'placed',
      paymentState: 'paid',
      trackingStatus: 'processing',
      totalCents: priced.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0),
      items,
    };
  })();
}

interface PricedLine {
  readonly product: Product;
  readonly quantity: number;
}

/** Resolves every requested line to a real product with stock behind it. */
function priceCart(db: Db, requested: readonly CartLine[]): PricedLine[] {
  return requested.map((line) => {
    const product = findProduct(db, line.productId);
    if (product === null) {
      throw new ShopAuthError(`no such product: ${line.productId}`);
    }
    if (product.stock < line.quantity) {
      throw new ShopAuthError(`only ${product.stock} of ${product.name} left`);
    }
    return { product, quantity: line.quantity };
  });
}

function insertOrder(db: Db, orderId: string, customerId: string, priced: readonly PricedLine[], now: Date): void {
  const isSubscription = priced.some((line) => line.product.isSubscription) ? 1 : 0;
  db.prepare(
    `INSERT INTO orders (
       id, customer_id, placed_at, delivered_at, status, payment_state, refunded_cents,
       is_subscription, tracking_status, signed_by_customer, condition_at_delivery
     ) VALUES (?, ?, ?, NULL, 'placed', 'paid', 0, ?, 'processing', 0, NULL)`,
  ).run(orderId, customerId, now.toISOString(), isSubscription);
}

/**
 * Inserts one order line and decrements stock, or throws and unwinds the order.
 *
 * The `stock >= ?` guard makes overselling impossible even if some future path
 * reaches this without `mergeLines` first: the update simply matches no rows,
 * and the surrounding transaction rolls the whole order back.
 */
function insertOrderItem(
  db: Db,
  orderId: string,
  line: PricedLine,
): { readonly itemId: string; readonly productId: string; readonly name: string; readonly quantity: number; readonly unitPriceCents: number } {
  const itemId = `ITM-${randomUUID()}`;
  const { product, quantity } = line;

  db.prepare(
    `INSERT INTO order_items (
       id, order_id, product_id, name, unit_price_cents, quantity, final_sale, digital, downloaded
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    itemId,
    orderId,
    product.id,
    product.name,
    product.priceCents,
    quantity,
    product.finalSale ? 1 : 0,
    product.digital ? 1 : 0,
  );

  const decremented = db
    .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
    .run(quantity, product.id, quantity);
  if (decremented.changes !== 1) {
    throw new ShopAuthError(`${product.name} just sold out`);
  }

  return {
    itemId,
    productId: product.id,
    name: product.name,
    quantity,
    unitPriceCents: product.priceCents,
  };
}

interface OrderItemRow {
  id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

/** A customer's own orders, newest first. Scoped by customer on purpose. */
export function listOrdersForCustomer(db: Db, customerId: string): readonly ShopOrder[] {
  const orders = db
    .prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY placed_at DESC, id DESC')
    .all(customerId) as {
    id: string;
    placed_at: string;
    status: string;
    payment_state: string;
    tracking_status: string;
  }[];

  const itemsFor = db.prepare(
    'SELECT id, name, quantity, unit_price_cents FROM order_items WHERE order_id = ?',
  );
  return orders.map((order) => {
    const items = itemsFor.all(order.id) as OrderItemRow[];
    return {
      id: order.id,
      placedAt: order.placed_at,
      status: order.status,
      paymentState: order.payment_state,
      trackingStatus: order.tracking_status,
      totalCents: items.reduce((sum, item) => sum + item.unit_price_cents * item.quantity, 0),
      items: items.map((item) => ({
        // The order line's own id, not the catalogue product id.
        //
        // These are different things and conflating them is a real bug: a line
        // is a row in *this* order, and it is the unit a return is filed
        // against. `productId` is a best-effort back-reference to the catalogue,
        // resolved by name, and it is null for a delisted product - so a page
        // that keys a selection by `productId` has two failure modes, both
        // bad. Two lines that name the same product share one key, so ticking
        // either ticks both; and an order that names a product twice cannot be
        // returned at all, because the second line is unreachable.
        itemId: item.id,
        // `order_items` snapshots the name, not the product id, so a historical
        // line is matched back to the catalogue by name for "buy again". A
        // missing match is reported honestly as a null id rather than guessed:
        // the client then leaves that line out of the refill instead of
        // re-ordering whatever happens to share a name.
        productId: productIdFor(db, item.name),
        name: item.name,
        quantity: item.quantity,
        unitPriceCents: item.unit_price_cents,
      })),
    };
  });
}

/** Resolves a catalogue product by its name, or null if it has been delisted. */
function productIdFor(db: Db, name: string): string | null {
  const row = db.prepare('SELECT id FROM products WHERE name = ?').get(name) as { id: string } | undefined;
  return row?.id ?? null;
}
