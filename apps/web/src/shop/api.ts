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
  readonly items: readonly {
    /** The order line id. A return is filed against this, not against a product. */
    readonly itemId: string;
    /** Null when the line's product has since been delisted. Not a return key. */
    readonly productId: string | null;
    readonly name: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }[];
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


/** One line of a return, as the server names it: an order line and a count. */
export interface CartLineInput {
  readonly productId: string;
  readonly quantity: number;
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

  /**
   * One order's conversation with the assistant.
   *
   * No `customerId` is sent: the session decides whose history this is. The
   * client cannot widen the scope of this call, which is the only way a history
   * endpoint is safe to expose to a browser.
   */
  chatHistory: (orderId: string): Promise<{ orderId: string; turns: readonly ChatTurn[] }> =>
    request(`/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`),

  /** Message counts per order, for the "3 messages" badge on the order picker. */
  chatSummary: (): Promise<{ counts: readonly { orderId: string; count: number }[] }> =>
    request('/api/shop/chat/summary'),

  /**
   * Whether a model is actually behind the assistant right now.
   *
   * Public and free of customer data. It exists because a page that behaves
   * identically with and without a model is indistinguishable from a model that
   * is not being called - which is exactly the state a missing API key produces,
   * and exactly the state a reviewer would otherwise report as "the AI does not
   * work".
   */
  assistantStatus: (): Promise<{ aiMode: string; aiAvailable: boolean; aiNote: string }> =>
    request('/api/shop/assistant-status'),

};

/**
 * Note for whoever adds a returns UI next.
 *
 * `POST /api/returns` exists on the server and is deliberately not called from
 * here. The shopper experience for a return is the order conversation, which
 * carries the intent and needs no form, so a second surface would be a second
 * way to file the same thing. When it is wanted, two details are load-bearing
 * and both are easy to get wrong:
 *
 * - send no `customerId`; the session cookie decides whose return this is.
 * - address lines by order line id, not product id. One order can hold two
 *   lines of the same product, and a product id files both under one key - which
 *   is how ticking one item ends up returning all of them.
 */

/**
 * One entry in a thread.
 *
 * `request` is the customer asking something and the answer they were given - a
 * cut-down `RefundRequestDto`, not the whole thing, because the stored request
 * also carries the policy trace, the raw extraction and the timing breakdown,
 * which are staff data and have no business in a shopper's browser.
 *
 * `update` is the assistant reporting what a person later did about that request.
 * It has no `message` and no decision, because the customer did not send one and
 * no new decision was reached - which is why the two are told apart in the type
 * rather than by the renderer checking for an empty message.
 */
export type ChatTurn =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly message: string;
      readonly responseText: string;
      /**
       * The refund decision vocabulary, declared locally for the reason above.
       * `pass` is deliberately absent: it is an order-status value, not something a
       * refund request can be decided as, and a chat turn can only ever be one of
       * these three.
       */
      readonly decision: 'approved' | 'denied' | 'escalated';
      readonly refundAmountCents: number;
      readonly createdAt: string;
    }
  | {
      readonly kind: 'update';
      readonly id: string;
      readonly requestId: string;
      readonly body: string;
      readonly createdAt: string;
    };

/** Money is rendered from integer cents, never from a float. */
export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'something went wrong';
}
