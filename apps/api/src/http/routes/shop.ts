import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiModeLabel, type AppContext } from '../context.js';
import { badRequest, conflict, HttpError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  authenticate,
  createUser,
  endSession,
  listDemoUsers,
  resolveShopSession,
  SESSION_COOKIE,
  startSession,
  type ShopUser,
} from '../../shop/auth.js';
import { checkout, listOrdersForCustomer, listProducts, type ShopOrder } from '../../shop/catalogue.js';
import { findRequestById, insertAuditEvent } from '../../db/requestRepository.js';
import { findOrder } from '../../db/orderRepository.js';
import { recordCustomerUpdate } from '../../db/customerUpdates.js';
import { conversationCounts, conversationForOrder } from '../../retrieval/conversation.js';
import { followUpFor } from '../../response/followUp.js';
import { AppealAlreadyPendingError, fileAppeal, openAppealForRequest } from '../../db/appeals.js';
import { FULLY_REFUNDED } from '../../policy/constants.js';

/**
 * Storefront endpoints, mounted under `/api/shop`.
 *
 * Everything a shopper can reach is scoped to the session's own customer, so no
 * handler here takes a customer id from the request. That is the property that
 * makes the storefront safe to point at live data: the only way to name a
 * customer is to be signed in as them.
 */

const ChatHistoryQuery = z.object({
  orderId: z.string().trim().min(1, 'orderId is required').max(120),
  // Bounded so one order with a long thread cannot return an unbounded payload
  // on every page load. The API returns the most recent N, oldest-first.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * What the storefront says when no key is configured.
 *
 * Short enough to sit in a panel, and complete enough to act on: paste the key
 * into `AI_API_KEY` in `.env` and restart. The provider is worked out from the
 * key, so there is no second step and no lookup table to get wrong. The README
 * section is named rather than linked by anchor because anchors move.
 */
const NO_API_KEY_NOTE =
  'No API key is set, so requests are being escalated to a person instead of read by a model. ' +
  'To turn the model on, paste your provider\'s key into AI_API_KEY in .env and restart the ' +
  'server - the provider is worked out from the key. README.md, "Configuration", has the details.';

const RegisterSchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
});

const LoginSchema = z.object({
  email: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

const DemoSchema = z.object({ email: z.string().min(1).max(200) });

const CheckoutSchema = z.object({
  lines: z
    .array(z.object({ productId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(10) }))
    .min(1)
    .max(25),
});

/**
 * Why the customer thinks the refusal was wrong, as the person who reads it
 * should see it: trimmed, and long enough to be useful but short enough to be
 * read.
 */
const AppealSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'tell the person what you think was missed')
    .max(2000, 'keep it under 2000 characters'),
});

/** Cookie flags. `httpOnly` keeps the token away from any script on the page. */
function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Omitted in development over plain http, where a secure cookie would be
    // silently dropped by the browser and every sign-in would appear to fail.
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60,
  });
}

function currentUser(request: FastifyRequest, ctx: AppContext): ShopUser | null {
  const cookies = request.cookies as Record<string, string | undefined>;
  return resolveShopSession(ctx.db, cookies[SESSION_COOKIE], ctx.now());
}

/**
 * Asking a person to look again at a refusal.
 *
 * Two routes, one subject. The POST accepts an appeal for any request the
 * policy *denied* - not the ones it escalated or approved, which have no refusal
 * to contest - and records it in the appeals table plus an audit event and the
 * composed update the customer reads. The GET just reports whether such an
 * appeal is already sitting with a person, so the page can switch the form into
 * a "with an agent" state without a blind POST.
 *
 * The only unsupported case is an order that has already been refunded in full.
 * That refusal cannot be revisited to anyone's benefit, so the appeal is refused
 * rather than quietly deleted - the customer is told the door is genuinely shut.
 */
function handleAppealStatus(
  request: FastifyRequest,
  ctx: AppContext,
): { appeal: { readonly id: string; readonly createdAt: string; readonly reason: string } | null } {
  const user = requireUser(request, ctx);
  return { appeal: appealFor(ctx, user, requestParm(request)) };
}

function persistAppeal(
  ctx: AppContext,
  user: ShopUser,
  requestId: string,
  refundRequest: { orderId: string | null },
  reason: string,
): { readonly id: string; readonly requestId: string; readonly createdAt: string; readonly reason: string } {
  return ctx.db.transaction((): {
    readonly id: string;
    readonly requestId: string;
    readonly createdAt: string;
    readonly reason: string;
  } => {
    let created: ReturnType<typeof fileAppeal>;
    try {
      created = fileAppeal(ctx.db, {
        requestId,
        customerId: user.customerId,
        reason,
        now: ctx.now(),
      });
    } catch (error) {
      if (error instanceof AppealAlreadyPendingError) {
        throw conflict('appeal_pending', 'this request is already with a person');
      }
      throw error;
    }
    insertAuditEvent(
      ctx.db,
      requestId,
      ctx.now().toISOString(),
      'appeal_filed',
      `appealed by ${user.customerId}: ${reason}`,
    );
    recordCustomerUpdate(ctx.db, {
      customerId: user.customerId,
      orderId: refundRequest.orderId,
      requestId,
      kind: 'appeal_submitted',
      body: followUpFor({
        kind: 'appeal_submitted',
        orderId: refundRequest.orderId,
        previousDecision: 'denied',
        decision: 'denied',
        amountCents: 0,
        paidCents: 0,
      }),
      now: ctx.now(),
    });
    return {
      id: created.id,
      requestId,
      createdAt: created.createdAt,
      reason: created.reason,
    };
  })();
}

function handleFileAppeal(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
): { appeal: { readonly id: string; readonly requestId: string; readonly createdAt: string; readonly reason: string } } {
  const body = parseBody(AppealSchema, request.body);
  const user = requireUser(request, ctx);
  const requestId = requestParm(request);

  const refundRequest = findRequestById(ctx.db, requestId);
  if (refundRequest === null || refundRequest.customerId !== user.customerId) {
    throw new NotFoundError('refund request', requestId);
  }
  if (appealFor(ctx, user, requestId) !== null) {
    throw conflict('appeal_pending', 'this request is already with a person');
  }
  if (refundRequest.decision !== 'denied') {
    throw new HttpError(
      409,
      'appeal_not_relevant',
      'only a refused request can be appealed - this one was not refused',
    );
  }
  refuseIfMoot(ctx, user, refundRequest.orderId);

  const appeal = persistAppeal(ctx, user, requestId, refundRequest, body.reason);
  reply.code(201);
  return { appeal };
}

function requireUser(request: FastifyRequest, ctx: AppContext): ShopUser {
  const user = currentUser(request, ctx);
  if (user === null) {
    throw new UnauthorizedError('sign in to appeal a decision');
  }
  return user;
}

function registerAppealRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/shop/refunds/:requestId/appeal', (request) => handleAppealStatus(request, ctx));
  app.post('/api/shop/refunds/:requestId/appeal', (request, reply) => handleFileAppeal(request, reply, ctx));
}

/** The request id from the path, as a string zod would not try to coerce. */
function requestParm(request: FastifyRequest): string {
  return (request.params as { requestId?: unknown }).requestId as string;
}

/**
 * The customer's own open appeal on a request, or null.
 *
 * Scoped by the session's customer rather than by the expensive call being an
 * existence oracle: a request id is a guessable string, and a signed-in customer
 * should not be able to learn whether a random id belongs to someone else. So
 * the request is loaded here and the ownership test is the guard, and the only
 * thing a foreign id produces is the same 404 everyone else gets.
 */
function appealFor(
  ctx: AppContext,
  user: ShopUser,
  requestId: string,
): { readonly id: string; readonly createdAt: string; readonly reason: string } | null {
  const refundRequest = findRequestById(ctx.db, requestId);
  if (refundRequest === null || refundRequest.customerId !== user.customerId) {
    return null;
  }
  const appeal = openAppealForRequest(ctx.db, requestId);
  return appeal === null
    ? null
    : { id: appeal.id, createdAt: appeal.createdAt, reason: appeal.reason };
}

/** Refuses an appeal on an order that has already been refunded in full. */
function refuseIfMoot(ctx: AppContext, user: ShopUser, orderId: string | null): void {
  if (orderId === null) {
    return;
  }
  const order = findOrder(ctx.db, user.customerId, orderId, ctx.now());
  if (order !== null && order.paymentState === FULLY_REFUNDED && order.refundedCents >= order.totalCents) {
    throw new HttpError(
      409,
      'appeal_impossible',
      'this order has already been refunded in full, so there is nothing a review could change - ' +
        'contact the shop if you believe this is a mistake',
    );
  }
}

/** Parses a body with zod, reporting field paths the way the rest of the API does. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'invalid request body',
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

function handleRegister(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): { user: ShopUser } {
  const body = parseBody(RegisterSchema, request.body);
  const user = createUser(ctx.db, body, ctx.now());
  const session = startSession(ctx.db, user, ctx.now());
  setSessionCookie(reply, session.token);
  reply.code(201);
  return { user: session.user };
}

function handleLogin(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): { user: ShopUser } {
  const body = parseBody(LoginSchema, request.body);
  const user = authenticate(ctx.db, body.email, body.password);
  const session = startSession(ctx.db, user, ctx.now());
  setSessionCookie(reply, session.token);
  return { user: session.user };
}

function handleDemoLogin(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): { user: ShopUser } {
  const body = parseBody(DemoSchema, request.body);
  const demo = listDemoUsers(ctx.db).find((u) => u.email === body.email.trim().toLowerCase());
  if (demo === undefined) {
    throw badRequest('that is not a demo account');
  }
  const session = startSession(ctx.db, demo, ctx.now());
  setSessionCookie(reply, session.token);
  return { user: session.user };
}

function handleLogout(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): { ok: true } {
  const cookies = request.cookies as Record<string, string | undefined>;
  endSession(ctx.db, cookies[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
}

function handleMe(request: FastifyRequest, ctx: AppContext): { user: ShopUser | null } {
  const user = currentUser(request, ctx);
  return user === null ? { user: null } : { user };
}

function handleAssistantStatus(ctx: AppContext): { aiMode: string; aiAvailable: boolean; aiNote: string } {
  return {
    aiMode: aiModeLabel(ctx.pipeline),
    aiAvailable: ctx.pipeline.analyzer.available,
    aiNote: ctx.pipeline.analyzer.available ? '' : NO_API_KEY_NOTE,
  };
}

function handleOrders(request: FastifyRequest, ctx: AppContext): { user: ShopUser | null; orders: readonly ShopOrder[] } {
  const user = currentUser(request, ctx);
  if (user === null) {
    return { user: null, orders: [] };
  }
  return { user, orders: listOrdersForCustomer(ctx.db, user.customerId) };
}

function handleCheckout(request: FastifyRequest, reply: FastifyReply, ctx: AppContext): { order: ShopOrder } {
  const body = parseBody(CheckoutSchema, request.body);
  const user = currentUser(request, ctx);
  if (user === null) {
    throw new UnauthorizedError('sign in to check out');
  }
  const order = checkout(ctx.db, user.customerId, body.lines, ctx.now());
  reply.code(201);
  return { order };
}

export function registerShopRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Public: the catalogue is browsable without an account, like a real shop.
  app.get('/api/shop/products', () => ({ products: listProducts(ctx.db) }));

  app.get('/api/shop/demo-accounts', () => ({ accounts: listDemoUsers(ctx.db) }));

  app.post('/api/shop/register', (request, reply) => handleRegister(request, reply, ctx));
  app.post('/api/shop/login', (request, reply) => handleLogin(request, reply, ctx));
  app.post('/api/shop/demo-login', (request, reply) => handleDemoLogin(request, reply, ctx));
  app.post('/api/shop/logout', (request, reply) => handleLogout(request, reply, ctx));
  app.get('/api/shop/me', (request) => handleMe(request, ctx));
  app.get('/api/shop/assistant-status', () => handleAssistantStatus(ctx));
  app.get('/api/shop/orders', (request) => handleOrders(request, ctx));
  app.post('/api/shop/checkout', (request, reply) => handleCheckout(request, reply, ctx));

  registerAppealRoutes(app, ctx);
  registerChatHistoryRoutes(app, ctx);
}

/**
 * Reading back a conversation.
 *
 * Split out because the shop's route table is already long enough, and because
 * these two are the only endpoints on it whose subject is a *thread* rather than
 * an order or a product.
 *
 * Neither takes a `customerId`. The session decides whose history this is, so
 * there is no parameter a caller could set to widen the scope - the safest
 * query in the system stops being the safest the moment a field is added that
 * says who to ask about.
 */
function registerChatHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/shop/chat/history', (request) => {
    const user = currentUser(request, ctx);
    if (user === null) {
      throw new UnauthorizedError('sign in to see your conversations');
    }
    const query = ChatHistoryQuery.safeParse(request.query);
    if (!query.success) {
      throw badRequest(
        'invalid history filter',
        query.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    return {
      orderId: query.data.orderId,
      turns: conversationForOrder(ctx.db, user.customerId, query.data.orderId, ctx.now(), query.data.limit),
    };
  });

  /** How many messages each of the shopper's orders has, for the order picker. */
  app.get('/api/shop/chat/summary', (request) => {
    const user = currentUser(request, ctx);
    // No session is not an error here: the order picker is on the page for
    // signed-out visitors too, and an empty count list is the honest answer.
    if (user === null) {
      return { counts: [] };
    }
    const counts = conversationCounts(ctx.db, user.customerId);
    return { counts: [...counts].map(([orderId, count]) => ({ orderId, count })) };
  });
}
