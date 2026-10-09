import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
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
import { checkout, listOrdersForCustomer, listProducts, type Product, type ShopOrder } from '../../shop/catalogue.js';
import { searchProducts } from '../../retrieval/catalogSearch.js';
import { findRequestById, insertAuditEvent } from '../../db/requestRepository.js';
import { findOrder } from '../../db/orderRepository.js';
import { recordCustomerUpdate } from '../../db/customerUpdates.js';
import { conversationCounts, conversationForOrder } from '../../retrieval/conversation.js';
import { followUpFor } from '../../response/followUp.js';
import { AppealAlreadyPendingError, fileAppeal, openAppealForRequest } from '../../db/appeals.js';
import { FULLY_REFUNDED } from '../../policy/constants.js';
import { isChatClosed } from '../../db/chatClosures.js';
import { ESCALATION_AGENT, forkScopeForHandoff, handoffById, liveClaimedForks, liveHandoffForThread, messagesForHandoff, recordAgentMessage, type ActiveHandoff, type AgentMessage, type ForkScope } from '../../db/handoffs.js';
import { scanForInjection } from '../../security/injection.js';
import type { LiveHub } from '../hub.js';
import type { Db } from '../../db/connection.js';

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
 * Catalogue search filters (ADR 0005).
 *
 * Every field is optional so a bare `GET` keeps its old shape. `inStock`
 * arrives as a query string, so it is an enum rather than a coerced boolean:
 * `Boolean("false")` is true, which would hide every out-of-stock item from
 * nobody and show them to everybody who asked to hide them.
 */
const ProductSearchQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  inStock: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  maxPriceCents: z.coerce.number().int().min(0).max(10_000_000).optional(),
  // Bounded so one catalogue cannot return an unbounded payload. Capped again
  // inside searchProducts, where the retrieval bound lives with the query.
  limit: z.coerce.number().int().min(1).max(50).default(20),
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

/**
 * Whether a person is holding this thread and has not answered yet.
 *
 * True only for a handoff a *named* agent owns - an unattended escalation is not a
 * person, so the composer stays open through it - and only until that agent
 * sends something. Both halves matter: waiting for an agent who has already replied
 * would leave a customer staring at a disabled box after being answered, and waiting
 * on the unattended slot would disable the composer in exactly the deployments where
 * nobody is ever going to reply.
 *
 * Thread-scoped, because a takeover forked from one order's escalation must not
 * silence the customer's other threads: a fork blocks only the thread it was
 * forked from, while a pre-fork takeover with no recorded scope keeps the old
 * whole-thread reach and blocks everywhere.
 */
function awaitingPersonReply(db: Db, customerId: string, orderId: string): boolean {
  const active = liveHandoffForThread(db, customerId, orderId);
  if (active === null || active.agentId === ESCALATION_AGENT) {
    return false;
  }
  if (active.requestId !== null) {
    const scope = forkScopeForHandoff(db, active);
    if (scope === null || scope.orderId !== orderId) {
      return false;
    }
  }
  return !handoffHasAgentReply(db, active.id);
}

function handoffHasAgentReply(db: Db, handoffId: string): boolean {
  const answer = db
    .prepare(
      `SELECT 1 AS present FROM agent_messages
        WHERE handoff_id = ? AND sender = 'agent'
        LIMIT 1`,
    )
    .get(handoffId);
  return answer !== undefined;
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

/**
 * The catalogue, optionally searched.
 *
 * Without filters this is the old full dump in `rowid` order. With any filter
 * it is the FTS-backed search ordered by rank then name. Prices and stock are
 * read from the database in both cases, so a suggestion can never carry a
 * price the shop did not set.
 */
function handleProducts(request: FastifyRequest, ctx: AppContext): { products: readonly Product[] } {
  const parsed = ProductSearchQuery.safeParse(request.query);
  if (!parsed.success) {
    throw badRequest(
      'invalid product filter',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const { q, inStock, maxPriceCents, limit } = parsed.data;
  if (q === undefined && inStock === undefined && maxPriceCents === undefined) {
    return { products: listProducts(ctx.db) };
  }
  return {
    products: searchProducts(ctx.db, {
      query: q ?? '',
      inStockOnly: inStock ?? false,
      maxPriceCents: maxPriceCents ?? null,
      limit,
    }),
  };
}

export function registerShopRoutes(app: FastifyInstance, ctx: AppContext, hub: LiveHub): void {
  // Public: the catalogue is browsable without an account, like a real shop.
  app.get('/api/shop/products', (request) => handleProducts(request, ctx));

  // Passwordless demo entry is a reviewer convenience, never a production
  // route: with pre-existing demo rows in the database the login would
  // otherwise mint a session without a password on a real deployment.
  // Unregistered paths answer 404 from Fastify itself.
  if (ctx.env.NODE_ENV !== 'production') {
    app.get('/api/shop/demo-accounts', () => ({ accounts: listDemoUsers(ctx.db) }));
    app.post('/api/shop/demo-login', (request, reply) => handleDemoLogin(request, reply, ctx));
  }

  app.post('/api/shop/register', (request, reply) => handleRegister(request, reply, ctx));
  app.post('/api/shop/login', (request, reply) => handleLogin(request, reply, ctx));
  app.post('/api/shop/logout', (request, reply) => handleLogout(request, reply, ctx));
  app.get('/api/shop/me', (request) => handleMe(request, ctx));
  app.get('/api/shop/orders', (request) => handleOrders(request, ctx));
  app.post('/api/shop/checkout', (request, reply) => handleCheckout(request, reply, ctx));

  registerAppealRoutes(app, ctx);
  registerChatHistoryRoutes(app, ctx, hub);
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
function registerChatHistoryRoutes(app: FastifyInstance, ctx: AppContext, hub: LiveHub): void {
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
      closed: isChatClosed(ctx.db, user.customerId, query.data.orderId),
      // A person is holding the thread and has not answered yet: the composer waits
      // for them rather than collecting messages nobody is reading, and reopens the
      // moment they reply. Derived server-side, because only the server knows which
      // agent messages are *after* the customer started typing to one.
      awaitingPerson: awaitingPersonReply(ctx.db, user.customerId, query.data.orderId),
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

  registerForkRoutes(app, ctx, hub);

}

const ForkParams = z.object({
  handoffId: z.string().trim().min(1, 'handoffId is required').max(120),
});

const ForkMessageBody = z.object({
  message: z.string().trim().min(1, 'message is required'),
});

const ForkMessagesQuery = z.object({
  // Bounded like the order thread: one fork with a long back-and-forth cannot
  // return an unbounded payload on every panel open.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The side panel's endpoints: one escalated case's human thread at a time.
 *
 * A fork is a takeover bound to a decided escalation, so its thread shows the
 * case it was forked from and takes follow-ups about that case without
 * touching the customer's other threads. Everything here is session-scoped
 * like the rest of this table: a handoff id names no customer, and a fork
 * belonging to someone else reads as not found rather than forbidden, so an
 * id guess reveals nothing about who it belongs to.
 */
function registerForkRoutes(app: FastifyInstance, ctx: AppContext, hub: LiveHub): void {
  /** The customer's live person-claimed takeovers, newest first. */
  app.get('/api/shop/cases', (request) => handleForkList(request, ctx));

  /** One fork's thread, oldest first. */
  app.get('/api/shop/cases/:handoffId/messages', (request) => handleForkMessages(request, ctx));

  /** A follow-up filed on the fork's thread, for the person on that case. */
  app.post('/api/shop/cases/:handoffId/message', (request, reply) => handleForkMessage(request, reply, ctx, hub));
}

interface ForkListItem {
  readonly handoffId: string;
  readonly orderId: string | null;
  readonly items: readonly { id: string; name: string }[];
  readonly unanswered: boolean;
  readonly startedAt: string;
}

function handleForkList(request: FastifyRequest, ctx: AppContext): { forks: readonly ForkListItem[] } {
  const user = currentUser(request, ctx);
  if (user === null) {
    throw new UnauthorizedError('sign in to see your conversations');
  }
  const now = ctx.now();
  return {
    forks: liveClaimedForks(ctx.db, user.customerId).map(({ handoff, scope }) => ({
      handoffId: handoff.id,
      orderId: scope?.orderId ?? handoff.orderId,
      items: forkItemNames(ctx.db, user.customerId, scope, handoff.orderId, now),
      unanswered: !handoffHasAgentReply(ctx.db, handoff.id),
      startedAt: handoff.startedAt,
    })),
  };
}

function handleForkMessages(request: FastifyRequest, ctx: AppContext): { handoffId: string; messages: readonly AgentMessage[] } {
  const user = currentUser(request, ctx);
  if (user === null) {
    throw new UnauthorizedError('sign in to see your conversations');
  }
  const handoffId = parseForkId(request);
  const fork = forkForCustomer(ctx.db, user.customerId, handoffId);
  const query = ForkMessagesQuery.safeParse(request.query);
  if (!query.success) {
    throw badRequest(
      'invalid history filter',
      query.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return { handoffId: fork.id, messages: messagesForHandoff(ctx.db, fork.id, query.data.limit) };
}

function handleForkMessage(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: AppContext,
  hub: LiveHub,
): { message: AgentMessage } {
  const user = currentUser(request, ctx);
  if (user === null) {
    throw new UnauthorizedError('sign in to write to your case');
  }
  const handoffId = parseForkId(request);
  const parsed = ForkMessageBody.safeParse(request.body);
  if (!parsed.success) {
    throw badRequest(
      'invalid request body',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  if (parsed.data.message.length > ctx.env.MAX_MESSAGE_LENGTH) {
    throw badRequest('message is too long', [`message: must be at most ${ctx.env.MAX_MESSAGE_LENGTH} characters`]);
  }
  const fork = forkForCustomer(ctx.db, user.customerId, handoffId);
  // Posting requires the takeover to be *live*: an ended fork stays readable as
  // history, but writing to it would silently file a message nobody answers. The
  // fork is verified by id (not by "is it the customer's only live one"), so a
  // customer who has two escalations with two agents can carry on both threads.
  const stillLive = ctx.db
    .prepare('SELECT 1 AS present FROM handoffs WHERE id = ? AND ended_at IS NULL')
    .get(fork.id);
  if (stillLive === undefined) {
    throw new NotFoundError('fork', handoffId);
  }
  const message = recordAgentMessage(ctx.db, {
    handoffId: fork.id,
    sender: 'customer',
    body: parsed.data.message,
    now: ctx.now(),
    injection: scanForInjection(parsed.data.message),
  });
  hub.notifyStaff({ type: 'customer.message', customerId: fork.customerId, message });
  hub.notifyStaff({ type: 'conversation.updated', customerId: fork.customerId, orderId: fork.orderId });
  reply.code(201);
  return { message };
}

function parseForkId(request: FastifyRequest): string {
  const params = ForkParams.safeParse(request.params);
  if (!params.success) {
    throw badRequest(
      'invalid fork id',
      params.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return params.data.handoffId;
}

/**
 * The fork this customer may read and write: theirs and person-held.
 *
 * Anything else — missing, someone else's, or still waiting for a person —
 * is not found: the fork box is a thread with a person on it, not a second
 * way to reach an unattended escalation. Ended forks stay readable (a closed
 * case's thread is still the customer's history); only posting requires the
 * takeover to be live, which the message route checks itself.
 */
function forkForCustomer(db: Db, customerId: string, handoffId: string): ActiveHandoff {
  const handoff = handoffById(db, handoffId);
  if (handoff === null || handoff.customerId !== customerId || handoff.unattended) {
    throw new NotFoundError('fork', handoffId);
  }
  return handoff;
}

function forkItemNames(
  db: Db,
  customerId: string,
  scope: ForkScope | null,
  orderId: string | null,
  now: Date,
): readonly { id: string; name: string }[] {
  const resolved = scope?.orderId ?? orderId;
  if (resolved === null) {
    return [];
  }
  const order = findOrder(db, customerId, resolved, now);
  if (order === null) {
    return [];
  }
  const wanted = scope === null ? null : new Set(scope.itemIds);
  return order.items
    .filter((line) => wanted === null || wanted.has(line.id))
    .map((line) => ({ id: line.id, name: line.name }));
}
