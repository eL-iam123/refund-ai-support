/**
 * The storefront's view of the API.
 *
 * Product types are declared locally instead of imported from `@refund/shared`.
 * The storefront is a separate deployable that depends on the shop API alone;
 * coupling it to the refund engine's types would drag its decision vocabulary
 * into a page that has no business knowing it. The transport is the shared one in
 * `httpClient`, so the session cookie rides on every call here as it does in the
 * staff console.
 */

import { request, post } from '../httpClient';
import type { ItemPickerOffer } from '../api';

export type { ItemPickerOffer };

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
interface Decision {
  readonly decision: 'approved' | 'denied' | 'escalated' | 'partial_refund' | 'exchange' | 'store_credit';
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
   *
   * The reply is either a decision (`request`) or the assistant's clarifying
   * question (`question`). They are told apart by the caller, because settling a
   * live turn into a question bubble is not the same as settling it into a
   * decision bubble - and a decision is never a question, or the reverse.
   */
  requestRefund: (input: { customerId: string; orderId: string; message: string }) =>
    post<
      | { request: RefundRequest }
      | { question: string; picker: ItemPickerOffer | null; dialogueId: string }
    >('/api/chat/messages', input),

  /**
   * One order's conversation with the assistant.
   *
   * No `customerId` is sent: the session decides whose history this is. The
   * client cannot widen the scope of this call, which is the only way a history
   * endpoint is safe to expose to a browser.
   */
  chatHistory: (orderId: string): Promise<{
    orderId: string;
    closed: boolean;
    /** Order lines a closure already put away; everything outside this set is still reportable. */
    closedItemIds: readonly string[];
    /** A person is holding the thread and has not answered yet. */
    awaitingPerson: boolean;
    turns: readonly ChatTurn[];
  }> => request(`/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`),

  /** Message counts per order, for the "3 messages" badge on the order picker. */
  chatSummary: (): Promise<{ counts: readonly { orderId: string; count: number }[] }> =>
    request('/api/shop/chat/summary'),

  /**
   * The customer's open appeal on a refused request, if any.
   */
  appealStatus: (requestId: string): Promise<{ appeal: { id: string; createdAt: string; reason: string } | null }> =>
    request(`/api/shop/refunds/${encodeURIComponent(requestId)}/appeal`),

  /**
   * Files an appeal on a refused request.
   */
  fileAppeal: (requestId: string, reason: string): Promise<{ appeal: { id: string; requestId: string; createdAt: string; reason: string } }> =>
    post(`/api/shop/refunds/${encodeURIComponent(requestId)}/appeal`, { reason }),

  /**
   * One customer's verdict on one answer, upserted.
   *
   * Fire-and-forget from the widget's point of view: the thumb flips locally
   * first, and the thread's next read reconciles it, so a slow vote never
   * blocks the conversation.
   */
  rateReply: (requestId: string, rating: 'up' | 'down'): Promise<{ rating: { requestId: string; rating: 'up' | 'down' } }> =>
    post('/api/shop/ratings', { requestId, rating }),

  /** This order's verdicts, for seeding the thumbs on reload. */
  orderRatings: (orderId: string): Promise<{ ratings: readonly { requestId: string; rating: 'up' | 'down' }[] }> =>
    request(`/api/shop/ratings?orderId=${encodeURIComponent(orderId)}`),

  /**
   * Uploads a photo during a live takeover.
   */
  chatMedia: (input: { orderId: string | null; caption?: string; media: { dataUrl: string } }): Promise<{ message: { kind: 'agent'; id: string; sender: 'agent' | 'customer'; body: string; createdAt: string; media: { type: string; url: string; bytes: number } | null } }> =>
    post('/api/shop/chat/media', input),

  /**
   * The customer's escalated cases currently with a person, newest first.
   *
   * One entry per live person-claimed takeover: the side panel's threads. An
   * entry names the case it was forked from, so the panel can say what the
   * person is looking at instead of showing another bare "an agent is here".
   */
  forks: (): Promise<{ forks: readonly CustomerFork[] }> => request('/api/shop/cases'),

  /** One fork's thread with the person on that case, oldest first. */
  forkMessages: (handoffId: string): Promise<{ handoffId: string; messages: readonly ForkThreadMessage[] }> =>
    request(`/api/shop/cases/${encodeURIComponent(handoffId)}/messages`),

  /** A follow-up filed on the fork's thread, for the person on that case. */
  sendForkMessage: (handoffId: string, message: string): Promise<{ message: ForkThreadMessage }> =>
    post(`/api/shop/cases/${encodeURIComponent(handoffId)}/message`, { message }),

};

/** One escalated case currently with a person, as the side panel shows it. */
export interface CustomerFork {
  readonly handoffId: string;
  readonly orderId: string | null;
  readonly items: readonly { id: string; name: string }[];
  /** A person has the case and has not answered yet. */
  readonly unanswered: boolean;
  readonly startedAt: string;
}

/** One message on a fork's thread. */
export interface ForkThreadMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly handoffId: string;
  readonly sender: 'agent' | 'customer';
  readonly body: string;
}

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
       * these.
       */
      readonly decision: 'approved' | 'denied' | 'escalated' | 'partial_refund' | 'exchange' | 'store_credit';
      readonly refundAmountCents: number;
      readonly itemIds: readonly string[];
      /**
       * The lines a mixed-cart decision left out, as the server stores them.
       *
       * Mirrors the server's cut-down `ChatTurn`: name and reason only, the two
       * fields the composed reply already quotes and the one `ruleId`/`priceCents`
       * never leave the staff view.
       */
      readonly blockedItems: readonly { readonly name: string; readonly reason: string }[];
      readonly createdAt: string;
    }
  | {
      readonly kind: 'dialogue';
      readonly id: string;
      readonly message: string;
      readonly question: string;
      /** The item picker offered here, when one was. Null for a question. */
      readonly offer: ItemPickerOffer | null;
      readonly itemIds: readonly string[];
      readonly createdAt: string;
    }
  | {
      readonly kind: 'update';
      readonly id: string;
      readonly requestId: string;
      readonly body: string;
      readonly createdAt: string;
    }
  | {
      /**
       * One message exchanged with a person during a live takeover. `sender`
       * names whose words they are: the customer's own routed messages and the
       * agent's replies both live here, as the server stores them.
       */
      readonly kind: 'agent';
      readonly id: string;
      readonly sender: 'agent' | 'customer';
      readonly body: string;
      readonly createdAt: string;
      /** Optional photo attached to this message, served under `/media/`. Null for text. */
      readonly media: { readonly type: string; readonly url: string; readonly bytes: number } | null;
    }
  | {
      /**
       * The moment the thread changed hands: the "connecting you to a customer
       * agent" notice, derived from the takeover row and present only while it
       * is live.
       */
      readonly kind: 'handoff';
      readonly id: string;
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
