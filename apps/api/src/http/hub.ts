import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import fastifyWebsocket from '@fastify/websocket';
import type { AppContext } from './context.js';
import { resolveShopSession, SESSION_COOKIE } from '../shop/auth.js';
import { adminEnabled, adminSigningKey } from '../config/env.js';
import { ADMIN_SESSION_COOKIE } from '../auth/session.js';
import { AuthError, verifyToken } from '../auth/tokens.js';
import type { AgentMessage } from '../db/handoffs.js';

/**
 * Live updates for a conversation.
 *
 * The design rule that keeps this simple is *notify, then refetch*. The REST
 * endpoints are the single source of truth for what a conversation looks like -
 * the same JSON the customer and the agent see, freshly read - and WebSockets
 * only say "something changed, come look". Two listeners can then never disagree
 * about what a thread contains, because neither carries a second copy of it.
 *
 * Two rooms, deliberately separate:
 *
 *  - one **per customer**, `customer:{customerId}`, carrying only that
 *    customer's events. A shopper's socket hears about their own takeover and
 *    their own new messages - never anyone else's, because the room key is
 *    derived from the cookie-authenticated identity server-side;
 *  - one **for staff**, shared, because an agent that is not watching a
 *    particular thread still wants to know a new one lit up. That is the live
 *    list refreshing itself, and it is how a takeover offer arrives while nobody
 *    is staring at one conversation.
 *
 * Authentication happens on the upgrade handshake, before a socket is accepted,
 * and the two channels authenticate the two ways the system already has: the
 * storefront's cookie for the customer, the staff token (as the httpOnly admin
 * cookie, the only way a browser can present it) for the agent. A WebSocket can
 * set no headers and no body, so a bare `Authorization` header is not a channel
 * it can use.
 */

export type ShopSocketEvent =
  | { readonly type: 'agent.connected'; readonly customerId: string; readonly agentId: string; readonly since: string }
  | { readonly type: 'agent.message'; readonly customerId: string; readonly message: AgentMessage }
  | { readonly type: 'agent.left'; readonly customerId: string; readonly orderId: string | null }
  | { readonly type: 'chat.closed'; readonly customerId: string; readonly orderId: string | null };

export type StaffSocketEvent =
  | {
      readonly type: 'handoff.started';
      readonly customerId: string;
      readonly orderId: string | null;
      readonly agentId: string;
      readonly since: string;
    }
  | {
      readonly type: 'handoff.ended';
      readonly customerId: string;
      readonly orderId: string | null;
    }
  | { readonly type: 'customer.message'; readonly customerId: string; readonly message: AgentMessage }
  | {
      readonly type: 'customer.pushing';
      readonly customerId: string;
      readonly orderId: string | null;
    }
  | { readonly type: 'conversation.updated'; readonly customerId: string; readonly orderId: string | null };

export interface LiveHub {
  readonly notifyCustomer: (customerId: string, event: ShopSocketEvent) => void;
  readonly notifyStaff: (event: StaffSocketEvent) => void;
}

/**
 * One publish, as seen by an observer.
 *
 * The hub is the one place that knows what was announced to whom, so it is the
 * one place a test can watch a notification *without* a socket: a route that
 * changes a thread and forgets to announce it is indistinguishable from one that
 * works, from the database alone. Observing here keeps that a property the tests
 * can assert rather than one they have to trust.
 */
export interface HubObservation {
  readonly channel: 'customer' | 'staff';
  /** Set for the customer channel, which is addressed per shopper. */
  readonly customerId?: string;
  readonly event: ShopSocketEvent | StaffSocketEvent;
}

/** The one place the shape of the push is shaped, so senders stay consistent. */
function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/** Cookie header value format is too simple to warrant a parser dependency. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) {
      return rest.join('=');
    }
  }
  return undefined;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing; nothing to do.
  }
}

/**
 * Registers the two channels and returns the publish side.
 *
 * The routes live inside the register call, on the same encapsulated scope the
 * plugin is registered on: a `websocket: true` route must be declared where the
 * websocket plugin is, or Fastify has no handler to attach to the upgrade.
 */
export function registerWebSockets(
  app: FastifyInstance,
  ctx: AppContext,
  observe?: (observation: HubObservation) => void,
): LiveHub {
  const shopRooms = new Map<string, Set<WebSocket>>();
  const staffSockets = new Set<WebSocket>();

  const hub: LiveHub = {
    notifyCustomer(customerId, event) {
      observe?.({ channel: 'customer', customerId, event });
      const room = shopRooms.get(customerId);
      if (room === undefined) {
        return;
      }
      for (const socket of room) {
        send(socket, event);
      }
    },
    notifyStaff(event) {
      observe?.({ channel: 'staff', event });
      for (const socket of staffSockets) {
        send(socket, event);
      }
    },
  };

  void app.register(async (scope) => {
    await scope.register(fastifyWebsocket);
    registerShopChannel(scope, ctx, shopRooms);
    registerStaffChannel(scope, ctx, staffSockets);
  });

  return hub;
}

/**
 * The customer's own channel: authenticated by the same storefront session the
 * REST chat routes trust, upgrade-side. Each shopper hears only their own room.
 */
function registerShopChannel(
  app: FastifyInstance,
  ctx: AppContext,
  shopRooms: Map<string, Set<WebSocket>>,
): void {
  app.get(
    '/api/shop/chat/ws',
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      // The same session the REST chat routes trust, from the same cookie in
      // the same place. An upgrade without a valid session is closed on the
      // handshake rather than parked in a room it does not belong to.
      const session = resolveShopSession(ctx.db, readCookie(request.headers.cookie, SESSION_COOKIE), ctx.now());
      if (session === null) {
        closeSocket(socket, 4401, 'not authenticated');
        return;
      }

      const room = shopRooms.get(session.customerId) ?? new Set<WebSocket>();
      room.add(socket);
      shopRooms.set(session.customerId, room);
      socket.on('close', () => {
        room.delete(socket);
        if (room.size === 0) {
          shopRooms.delete(session.customerId);
        }
      });
    },
  );
}

/**
 * The shared staff channel: authenticated by the staff token carried as the
 * httpOnly admin cookie, the only way a browser can present a header-less
 * WebSocket upgrade.
 */
function registerStaffChannel(
  app: FastifyInstance,
  ctx: AppContext,
  staffSockets: Set<WebSocket>,
): void {
  app.get(
    '/api/staff/conversation/ws',
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      // The staff console is a no-op until it is configured, exactly like its
      // REST routes. The 404 the REST routes answer is not an option here - a
      // WebSocket handshake has a status code, not a body - so the socket is
      // closed with 1008 instead.
      if (!adminEnabled(ctx.env)) {
        closeSocket(socket, 1008, 'staff console is not configured');
        return;
      }
      try {
        verifyToken(adminSigningKey(ctx.env), readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE) ?? '', ctx.now());
      } catch (error) {
        if (error instanceof AuthError) {
          closeSocket(socket, 4401, 'not authenticated');
          return;
        }
        closeSocket(socket, 1011, 'internal error');
        return;
      }

      staffSockets.add(socket);
      socket.on('close', () => staffSockets.delete(socket));
    },
  );
}