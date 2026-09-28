/**
 * The storefront's view of the API.
 *
 * Two things here are load-bearing rather than incidental.
 *
 * Every call sends `credentials: 'include'`. The session lives in an httpOnly
 * cookie, so without it the server sees an anonymous visitor and the shopper's
 * orders vanish - which reads as a bug in the shop rather than a missing header.
 *
 * Product types are declared locally instead of imported from `@refund/shared`.
 * The storefront is a separate deployable that depends on the shop API alone;
 * coupling it to the refund engine's types would drag its decision vocabulary
 * into a page that has no business knowing it.
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
  readonly testsPolicy: string | null;
  readonly imageHue: number;
}

export interface ShopUser {
  readonly id: string;
  readonly email: string;
  readonly customerId: string;
  readonly isDemo: boolean;
}

export interface ShopOrder {
  readonly id: string;
  readonly placedAt: string;
  readonly status: string;
  readonly paymentState: string;
  readonly trackingStatus: string;
  readonly totalCents: number;
  readonly items: readonly { name: string; quantity: number; unitPriceCents: number }[];
}

/** The decision as the refund engine returns it, nested under `decision`. */
export interface Decision {
  readonly decision: 'approved' | 'denied' | 'escalated' | 'pass';
  readonly refundAmountCents: number;
  readonly eligibleAmountCents: number;
  readonly currency: string;
  readonly summary: string;
  readonly policyRef: string;
}

/** One persisted refund request, trimmed to what a shopper is shown. */
export interface RefundRequest {
  readonly id: string;
  readonly orderId: string | null;
  readonly customerId: string;
  readonly decision: Decision;
  readonly responseText: string;
}

export class ShopApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ShopApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    let code = 'http_error';
    let message = `request failed with status ${response.status}`;
    try {
      const envelope = (await response.json()) as { error?: string; message?: string };
      code = envelope.error ?? code;
      message = envelope.message ?? message;
    } catch {
      // A non-JSON body still has to render as something readable.
    }
    throw new ShopApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const shopApi = {
  products: (): Promise<{ products: readonly Product[] }> => request('/api/shop/products'),

  demoAccounts: (): Promise<{ accounts: readonly ShopUser[] }> => request('/api/shop/demo-accounts'),

  me: (): Promise<{ user: ShopUser | null }> => request('/api/shop/me'),

  login: (email: string, password: string): Promise<{ user: ShopUser }> =>
    post('/api/shop/login', { email, password }),

  demoLogin: (email: string): Promise<{ user: ShopUser }> => post('/api/shop/demo-login', { email }),

  register: (email: string, password: string, name: string): Promise<{ user: ShopUser }> =>
    post('/api/shop/register', { email, password, name }),

  logout: (): Promise<{ ok: boolean }> => post('/api/shop/logout', {}),

  orders: (): Promise<{ user: ShopUser | null; orders: readonly ShopOrder[] }> => request('/api/shop/orders'),

  checkout: (lines: readonly { productId: string; quantity: number }[]): Promise<{ order: ShopOrder }> =>
    post('/api/shop/checkout', { lines }),

  /**
   * The real refund pipeline, reached over the same session.
   *
   * `customerId` is sent because the endpoint's schema requires it, but the
   * server overrides it with the session's customer when a session exists. See
   * the note on the Orders page: without signing in, this field is believed.
   */
  requestRefund: (input: { customerId: string; orderId: string; message: string }) =>
    post<{ request: RefundRequest }>('/api/chat/messages', input),
};

/** Money is rendered from integer cents, never from a float. */
export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'something went wrong';
}
