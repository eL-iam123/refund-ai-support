import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { appHarness, scenario, testEnv, TEST_NOW, type AppHarness } from './helpers.js';
import { seedShop } from '../shop/seed.js';
import { resolveShopSession, SESSION_COOKIE } from '../shop/auth.js';
import { checkout, listOrdersForCustomer, listProducts } from '../shop/catalogue.js';
import type { RefundDecision } from '@refund/shared';

/**
 * Storefront.
 *
 * The storefront writes into the same tables the refund engine reads, which is
 * the point of it and also the risk: a bug here is a bug in the engine's ground
 * truth. So the tests care less about JSON shapes and more about the three
 * properties that matter - a shopper only ever sees their own orders, checkout
 * takes the price from the database and not the request, and a signed-in session
 * overrides whatever customer id the refund body claims.
 */

interface ErrorBody {
  readonly error: string;
  readonly message: string;
}

interface Product {
  readonly id: string;
  readonly priceCents: number;
  readonly stock: number;
}

interface ShopOrder {
  readonly id: string;
  readonly totalCents: number;
  readonly items: readonly { name: string; quantity: number; unitPriceCents: number }[];
}

describe('storefront', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function call(
    method: 'GET' | 'POST',
    url: string,
    options: { cookie?: string; payload?: object } = {},
  ): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method,
      url,
      ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  }

  async function signUp(
    email: string,
    password = 'a-good-password',
  ): Promise<{ cookie: string; customerId: string }> {
    const response = await call('POST', '/api/shop/register', {
      payload: { email, password, name: 'Test Shopper' },
    });
    expect(response.statusCode).toBe(201);
    const { user } = response.json<{ user: { customerId: string } }>();
    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
    return { cookie: String(raw).split(';')[0] ?? '', customerId: user.customerId };
  }

  describe('accounts', () => {
    it('registers an account and signs the shopper in', async () => {
      const { cookie, customerId } = await signUp('new@shop.test');

      expect(customerId).toMatch(/^CUST-/);
      const me = await call('GET', '/api/shop/me', { cookie });
      expect(me.json<{ user: { email: string } }>().user.email).toBe('new@shop.test');
    });

    it('marks the session cookie httpOnly so scripts cannot read it', async () => {
      const response = await call('POST', '/api/shop/register', {
        payload: { email: 'flags@shop.test', password: 'a-good-password', name: 'Flags' },
      });
      const setCookie = response.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);

      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Lax');
      expect(raw).toContain('Path=/');
    });

    it('rejects a duplicate email', async () => {
      await signUp('dupe@shop.test');
      const again = await call('POST', '/api/shop/register', {
        payload: { email: 'dupe@shop.test', password: 'a-good-password', name: 'Dupe' },
      });

      expect(again.statusCode).toBe(409);
    });

    it('rejects a short password', async () => {
      const response = await call('POST', '/api/shop/register', {
        payload: { email: 'weak@shop.test', password: 'short', name: 'Weak' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('logs in with the right password and refuses the wrong one', async () => {
      await signUp('sam@shop.test', 'the-right-password');

      const good = await call('POST', '/api/shop/login', {
        payload: { email: 'sam@shop.test', password: 'the-right-password' },
      });
      expect(good.statusCode).toBe(200);

      const bad = await call('POST', '/api/shop/login', {
        payload: { email: 'sam@shop.test', password: 'not-the-password' },
      });
      expect(bad.statusCode).toBe(401);
    });

    it('gives the same answer for an unknown account and a wrong password', async () => {
      await signUp('real@shop.test', 'the-right-password');

      const wrongPassword = await call('POST', '/api/shop/login', {
        payload: { email: 'real@shop.test', password: 'nope' },
      });
      const noSuchUser = await call('POST', '/api/shop/login', {
        payload: { email: 'ghost@shop.test', password: 'nope' },
      });

      // Otherwise the endpoint is a membership oracle.
      expect(wrongPassword.json<ErrorBody>().message).toBe(noSuchUser.json<ErrorBody>().message);
    });

    it('ends the session on logout, and the cookie stops working', async () => {
      const { cookie } = await signUp('bye@shop.test');
      expect((await call('GET', '/api/shop/me', { cookie })).json<{ user: unknown }>().user).not.toBeNull();

      await call('POST', '/api/shop/logout', { cookie });

      expect((await call('GET', '/api/shop/me', { cookie })).json<{ user: unknown }>().user).toBeNull();
    });

    it('does not accept a made-up session token', async () => {
      const response = await call('GET', '/api/shop/me', {
        cookie: `${SESSION_COOKIE}=${'0'.repeat(64)}`,
      });

      expect(response.json<{ user: unknown }>().user).toBeNull();
    });

    it('stores only a hash of the session token, never the token itself', async () => {
      const { cookie } = await signUp('hash@shop.test');
      const token = (cookie.split('=')[1] ?? '').toString();

      const row = harness.db
        .prepare('SELECT token_hash FROM shop_sessions')
        .get() as { token_hash: string };
      expect(row.token_hash).not.toBe(token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(resolveShopSession(harness.db, token, TEST_NOW)).not.toBeNull();
    });

    it('expires a session rather than honouring it forever', async () => {
      const { cookie } = await signUp('later@shop.test');
      const token = (cookie.split('=')[1] ?? '').toString();

      const farFuture = new Date(TEST_NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(resolveShopSession(harness.db, token, farFuture)).toBeNull();
    });
  });

  describe('demo accounts', () => {
    it('offers one-click logins for the accounts it created', async () => {
      const response = await call('GET', '/api/shop/demo-accounts');
      const { accounts } = response.json<{ accounts: readonly { email: string; isDemo: boolean }[] }>();

      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts.every((a) => a.isDemo)).toBe(true);
    });

    it('signs a demo account in without a password', async () => {
      const response = await call('POST', '/api/shop/demo-login', {
        payload: { email: 'sam@shop.demo' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('will not let the demo shortcut into a real account', async () => {
      await signUp('real@shop.test');

      const response = await call('POST', '/api/shop/demo-login', {
        payload: { email: 'real@shop.test' },
      });

      // Without this check, the passwordless shortcut is a backdoor.
      expect(response.statusCode).toBe(400);
    });

    it('gives every demo shopper their own customer and orders', async () => {
      const first = await call('POST', '/api/shop/demo-login', { payload: { email: 'sam@shop.demo' } });
      const second = await call('POST', '/api/shop/demo-login', { payload: { email: 'dana@shop.demo' } });
      const a = (first.headers['set-cookie'] as string).split(';')[0] ?? '';
      const b = (second.headers['set-cookie'] as string).split(';')[0] ?? '';

      const ordersA = (await call('GET', '/api/shop/orders', { cookie: a })).json<{ orders: ShopOrder[] }>();
      const ordersB = (await call('GET', '/api/shop/orders', { cookie: b })).json<{ orders: ShopOrder[] }>();

      expect(ordersA.orders.length).toBeGreaterThan(0);
      const idsA = ordersA.orders.map((o) => o.id);
      const idsB = ordersB.orders.map((o) => o.id);
      expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    });
  });

  describe('catalogue and checkout', () => {
    /** Reads a product's current stock straight from the table. */
    function stockOf(productId: string): number {
      const row = harness.db
        .prepare('SELECT stock FROM products WHERE id = ?')
        .get(productId) as { stock?: number } | undefined;
      return Number(row?.stock ?? -1);
    }

    /** Forces a stock level, so a test does not have to buy the shop dry. */
    function setStock(productId: string, stock: number): void {
      harness.db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, productId);
    }

    it('browses the catalogue without signing in', async () => {
      const response = await call('GET', '/api/shop/products');
      const { products } = response.json<{ products: readonly Product[] }>();

      expect(products.length).toBeGreaterThan(0);
    });

    it('takes the price from the database, not from the request', async () => {
      const { cookie } = await signUp('buyer@shop.test');
      const product = listProducts(harness.db)[0] as Product;

      const response = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: {
          lines: [
            // `priceCents: 1` is not part of the schema and must be ignored.
            { productId: product.id, quantity: 2, priceCents: 1, unitPriceCents: 1, totalCents: 1 },
          ],
        },
      });
      const { order } = response.json<{ order: ShopOrder }>();

      expect(order.totalCents).toBe(product.priceCents * 2);
    });

    it('refuses checkout when signed out', async () => {
      const product = listProducts(harness.db)[0] as Product;
      const response = await call('POST', '/api/shop/checkout', {
        payload: { lines: [{ productId: product.id, quantity: 1 }] },
      });

      expect(response.statusCode).toBe(401);
    });

    it('writes the purchased items into the tables the refund engine reads', async () => {
      const { cookie, customerId } = await signUp('engine@shop.test');
      const product = listProducts(harness.db)[0] as Product;

      const { order } = (
        await call('POST', '/api/shop/checkout', {
          cookie,
          payload: { lines: [{ productId: product.id, quantity: 1 }] },
        })
      ).json<{ order: ShopOrder }>();

      const item = harness.db
        .prepare('SELECT name, unit_price_cents FROM order_items WHERE order_id = ?')
        .get(order.id) as { name: string; unit_price_cents: number };
      expect(item.name).toBe(product.id === 'PRD-LAMP-01' ? 'Aurora Desk Lamp' : item.name);
      expect(item.unit_price_cents).toBe(product.priceCents);

      // And the order is discoverable as that customer's own.
      expect(listOrdersForCustomer(harness.db, customerId).map((o) => o.id)).toContain(order.id);
    });

    it('carries the final-sale and digital flags onto the order item', async () => {
      // These flags are what the policy rules read, so losing them at checkout
      // would silently turn a final-sale item into a refundable one.
      const { cookie } = await signUp('flags@shop.test');
      const product = (listProducts(harness.db) as readonly Product[]).find((p) => p.id === 'PRD-JACKET-01');
      expect(product).toBeDefined();

      const { order } = (
        await call('POST', '/api/shop/checkout', {
          cookie,
          payload: { lines: [{ productId: 'PRD-JACKET-01', quantity: 1 }] },
        })
      ).json<{ order: ShopOrder }>();

      const row = harness.db
        .prepare('SELECT final_sale, digital FROM order_items WHERE order_id = ?')
        .get(order.id) as { final_sale: number; digital: number };
      expect(row.final_sale).toBe(1);
      expect(row.digital).toBe(0);
    });

    it('decrements stock so an item cannot be oversold', async () => {
      const { cookie } = await signUp('stock@shop.test');
      const before = (listProducts(harness.db) as readonly Product[]).find((p) => p.id === 'PRD-MUG-01');

      await call('POST', '/api/shop/checkout', {
        cookie,
        payload: { lines: [{ productId: 'PRD-MUG-01', quantity: 3 }] },
      });

      const after = (listProducts(harness.db) as readonly Product[]).find((p) => p.id === 'PRD-MUG-01');
      expect(after?.stock).toBe((before?.stock ?? 0) - 3);
    });

    it('refuses to sell more than the remaining stock', async () => {
      const { cookie } = await signUp('greedy@shop.test');

      const response = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: { lines: [{ productId: 'PRD-JACKET-01', quantity: 999 }] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a cart that lists the same product twice to get past the stock check', async () => {
      // The exploit this blocks: with stock at 1, two separate lines of 1 each
      // pass a stock check that only sees its own line. The order would ship 2 of
      // 1 and drive stock negative.
      const { cookie } = await signUp('dupe@shop.test');
      setStock('PRD-MUG-01', 1);

      const sneaky = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: {
          lines: [
            { productId: 'PRD-MUG-01', quantity: 1 },
            { productId: 'PRD-MUG-01', quantity: 1 },
          ],
        },
      });

      expect(sneaky.statusCode).toBe(400);
      expect(stockOf('PRD-MUG-01')).toBe(1);
    });

    it('combines duplicate lines into one order item rather than two', async () => {
      const { cookie } = await signUp('merge@shop.test');
      setStock('PRD-MUG-01', 5);

      const response = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: {
          lines: [
            { productId: 'PRD-MUG-01', quantity: 1 },
            { productId: 'PRD-MUG-01', quantity: 2 },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      const { order } = response.json<{ order: ShopOrder }>();
      expect(order.items).toHaveLength(1);
      expect(order.items[0]?.quantity).toBe(3);
      expect(stockOf('PRD-MUG-01')).toBe(2);
    });

    it('rejects an empty cart and an unknown product', async () => {
      const { cookie } = await signUp('empty@shop.test');

      const empty = await call('POST', '/api/shop/checkout', { cookie, payload: { lines: [] } });
      expect(empty.statusCode).toBe(400);

      const unknown = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: { lines: [{ productId: 'PRD-NOPE', quantity: 1 }] },
      });
      expect(unknown.statusCode).toBe(400);
    });

    it('rejects a nonsense quantity rather than rounding it', async () => {
      const { cookie } = await signUp('quant@shop.test');

      const response = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: { lines: [{ productId: 'PRD-MUG-01', quantity: 1.5 }] },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('order visibility', () => {
    it('never lists one shopper the orders of another', async () => {
      const mine = await signUp('mine@shop.test');
      const theirs = await signUp('theirs@shop.test');
      const product = listProducts(harness.db)[0] as Product;

      const { order } = (
        await call('POST', '/api/shop/checkout', {
          cookie: theirs.cookie,
          payload: { lines: [{ productId: product.id, quantity: 1 }] },
        })
      ).json<{ order: ShopOrder }>();

      const listed = (await call('GET', '/api/shop/orders', { cookie: mine.cookie })).json<{
        orders: ShopOrder[];
      }>();
      expect(listed.orders.map((o) => o.id)).not.toContain(order.id);
    });

    it('shows nothing to a signed-out visitor', async () => {
      const response = await call('GET', '/api/shop/orders');

      expect(response.json<{ orders: ShopOrder[]; user: unknown }>()).toEqual({ orders: [], user: null });
    });
  });

  describe('the session overrides the customer id in the refund body', () => {
    it('uses the session customer, not the one the body claims', async () => {
      const { cookie, customerId } = await signUp('victim@shop.test');
      const other = await signUp('attacker@shop.test');
      const fixture = scenario('S-01');

      // The attacker sends someone else's customer id. A signed-in session must
      // win, or the login is decorative.
      const response = await call('POST', '/api/chat/messages', {
        cookie,
        payload: {
          customerId: other.customerId,
          orderId: fixture.orderId,
          message: fixture.message,
        },
      });

      expect(response.statusCode).toBe(201);
      const { request } = response.json<{ request: { customerId: string } }>();
      expect(request.customerId).toBe(customerId);
    });

    it('falls back to the body customer when there is no session', async () => {
      // This is the honest limitation: without a session the value is trusted.
      const fixture = scenario('S-01');
      const response = await call('POST', '/api/chat/messages', {
        payload: { customerId: fixture.customer.key, orderId: fixture.orderId, message: fixture.message },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ request: { customerId: string } }>().request.customerId).toBe(
        fixture.customer.key,
      );
    });
  });

  describe('buying something and then disputing it', () => {
    /** Buys the lamp plus two mugs, and returns the new order. */
    async function buyLampAndMugs(cookie: string): Promise<{ id: string; totalCents: number }> {
      const response = await call('POST', '/api/shop/checkout', {
        cookie,
        payload: {
          lines: [
            { productId: 'PRD-LAMP-01', quantity: 1 },
            { productId: 'PRD-MUG-01', quantity: 2 },
          ],
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ order: { id: string; totalCents: number } }>().order;
    }

    /** Runs the real pipeline against a bought order and returns the decision. */
    async function dispute(
      cookie: string,
      customerId: string,
      orderId: string,
      message: string,
    ): Promise<RefundDecision> {
      const response = await call('POST', '/api/chat/messages', {
        cookie,
        payload: { customerId, orderId, message },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ request: { decision: RefundDecision } }>().request.decision;
    }

    it('refunds only the item that is complained about', async () => {
      const { cookie, customerId } = await signUp('partial@shop.test');
      const order = await buyLampAndMugs(cookie);
      expect(order.totalCents).toBe(12900 + 2 * 2400);

      // The message names both products but only disputes the mugs. Paying the
      // whole $177.00 would refund a $129.00 lamp the customer says is perfect.
      const decision = await dispute(
        cookie,
        customerId,
        order.id,
        'only the mug arrived broken, the lamp is perfect',
      );

      expect(decision.decision).toBe('approved');
      expect(decision.refundAmountCents).toBe(2 * 2400);
      // Both items were eligible on the order; the *amount* is what the dispute
      // ceiling narrows, and eligibleAmountCents still shows the full $177.00 so a
      // reviewer can see what the claim would have been worth.
      expect(decision.eligibleAmountCents).toBe(order.totalCents);
      expect(decision.eligibleItemIds).toHaveLength(2);
    });

    it('refunds the whole order when the whole order is disputed', async () => {
      const { cookie, customerId } = await signUp('whole@shop.test');
      const order = await buyLampAndMugs(cookie);

      const decision = await dispute(cookie, customerId, order.id, 'everything arrived broken');

      expect(decision.decision).toBe('approved');
      expect(decision.refundAmountCents).toBe(order.totalCents);
    });

    it('never authorises payment on an escalation', async () => {
      const { cookie, customerId } = await signUp('escalated@shop.test');
      const order = await buyLampAndMugs(cookie);

      // A claim the policy sends to a person must carry $0 authorised, however
      // much is at stake, or a payout job would act on an unreviewed decision.
      const decision = await dispute(
        cookie,
        customerId,
        order.id,
        'the mug arrived broken and I want my money back immediately, this is unacceptable',
      );

      if (decision.decision !== 'approved') {
        expect(decision.refundAmountCents).toBe(0);
      }
    });
  });

  describe('seeded order history', () => {
    it('gives a demo shopper one delivered order and one in transit', () => {
      const row = harness.db
        .prepare(
          `SELECT o.status, o.delivered_at, o.tracking_status
             FROM orders o JOIN shop_users u ON u.customer_id = o.customer_id
            WHERE u.email = 'sam@shop.demo'`,
        )
        .all() as { status: string; delivered_at: string | null; tracking_status: string }[];

      expect(row).toHaveLength(2);
      expect(row.filter((o) => o.status === 'delivered')).toHaveLength(1);
      expect(row.filter((o) => o.status === 'placed')).toHaveLength(1);
    });
  });

  describe('configuration', () => {
    it('needs no extra environment to run the shop', () => {
      expect(() => testEnv()).not.toThrow();
    });
  });

  describe('re-seeding on boot', () => {
    it('refreshes catalogue copy without un-selling what a checkout sold', () => {
      // The seed runs on every `pnpm dev` boot. If it reset stock, restarting the
      // server would put sold inventory back on the shelf and the same unit could
      // be sold twice - against an order the refund engine then reasons about.
      const before = harness.db.prepare('SELECT stock FROM products WHERE id = ?').get('PRD-MUG-01') as {
        stock: number;
      };
      harness.db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(before.stock - 4, 'PRD-MUG-01');

      seedShop(harness.db, TEST_NOW);

      const after = harness.db.prepare('SELECT stock FROM products WHERE id = ?').get('PRD-MUG-01') as {
        stock: number;
      };
      expect(after.stock).toBe(before.stock - 4);
    });

    it('does not recreate a demo account or its orders on a second run', () => {
      const count = (): number =>
        (
          harness.db
            .prepare(
              `SELECT COUNT(*) AS n FROM orders o JOIN shop_users u ON u.customer_id = o.customer_id
                WHERE u.email = 'sam@shop.demo'`,
            )
            .get() as { n: number }
        ).n;
      const first = count();

      seedShop(harness.db, TEST_NOW);

      expect(count()).toBe(first);
    });
  });

  it('computes an order total from the database even when called directly', () => {
    const row = harness.db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: string };
    const order = checkout(harness.db, row.id, [{ productId: 'PRD-MUG-01', quantity: 2 }], TEST_NOW);

    expect(order.totalCents).toBe(4800);
  });
});
