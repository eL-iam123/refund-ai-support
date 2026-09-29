import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { seedShop } from '../shop/seed.js';

/**
 * Signing in as a shopper, and being one.
 *
 * The history tests need a customer with orders, a second customer who does not
 * have them, and the ability to send messages as either. Assembling that by hand
 * in every test would be a dozen lines of cookie-parsing repeated until one
 * copy drifts, so it lives here once.
 */

const PASSWORD = 'refund-demo-2026';

export interface SignedIn {
  readonly cookie: string;
  readonly customerId: string;
  /** Their first order, which every test that sends a message needs. */
  readonly orderId: string;
  /** Buys a different product, giving this customer a second order to talk about. */
  buyAgain: () => Promise<string>;
  send: (orderId: string, message: string) => Promise<{ decision: string; duplicate: unknown }>;
}

export function cookiesOf(session: SignedIn): string {
  return session.cookie;
}

/** A harness with the shop's products and demo accounts seeded. */
export async function shopHarness(): Promise<AppHarness> {
  const harness = await appHarness();
  seedShop(harness.db, TEST_NOW);
  return harness;
}

/**
 * Signs in as a demo shopper and gives them one order.
 *
 * The order is created by buying something rather than by inserting a row: a
 * fixture that skips checkout is a fixture that would not notice checkout being
 * broken, and order ids are what these tests are partitioned by.
 */
export async function signIn(h: AppHarness, email: string): Promise<SignedIn> {
  const app = h.app;

  const response = await app.inject({
    method: 'POST',
    url: '/api/shop/login',
    payload: { email, password: PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in for ${email} returned ${response.statusCode}: ${response.body}`);
  }
  const cookie = firstCookie(response);
  const { user } = response.json<{ user: { customerId: string } }>();

  const orderId = await buySomething(app, cookie);
  return {
    cookie,
    customerId: user.customerId,
    orderId,
    buyAgain: async () => buySomething(app, cookie, 1),
    send: async (target: string, message: string) => {
      const sent = await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie },
        payload: { customerId: user.customerId, orderId: target, message },
      });
      // 201 for a new decision, 200 for a recognised repeat. Both are successes
      // and both return a request, so both are accepted here; the duplicate
      // assertions check the body rather than the status.
      if (sent.statusCode !== 200 && sent.statusCode !== 201) {
        throw new Error(`send returned ${sent.statusCode}: ${sent.body}`);
      }
      const body = sent.json<{ request: { decision: { decision: string } }; duplicate: unknown }>();
      return { decision: body.request.decision.decision, duplicate: body.duplicate };
    },
  };
}

/**
 * The id of a product to buy, read from the catalogue rather than hard-coded.
 *
 * `nth` picks a different product each time so a second call produces a second
 * order. Two orders of the same line would still be two orders, but the test
 * that compares two threads is easier to read when the two complaints are
 * obviously about different things.
 */
async function productIdAt(h: FastifyInstance, nth: number): Promise<string> {
  const response = await h.inject({ method: 'GET', url: '/api/shop/products' });
  const products = response.json<{ products: readonly { id: string }[] }>().products;
  const product = products[nth];
  if (product === undefined) {
    throw new Error(`the seeded catalogue has no product at index ${nth}`);
  }
  return product.id;
}

async function buySomething(h: FastifyInstance, cookie: string, nth = 0): Promise<string> {
  const productId = await productIdAt(h, nth);
  const response = await h.inject({
    method: 'POST',
    url: '/api/shop/checkout',
    headers: { cookie },
    payload: { lines: [{ productId, quantity: 1 }] },
  });
  if (response.statusCode !== 201) {
    throw new Error(`checkout returned ${response.statusCode}: ${response.body}`);
  }
  return response.json<{ order: { id: string } }>().order.id;
}

function firstCookie(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined ? '' : String(value).split(';')[0] ?? '';
}
