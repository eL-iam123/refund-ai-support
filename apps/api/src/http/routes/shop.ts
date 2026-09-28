import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, UnauthorizedError } from '../errors.js';
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
import { checkout, listOrdersForCustomer, listProducts } from '../../shop/catalogue.js';

/**
 * Storefront endpoints, mounted under `/api/shop`.
 *
 * Everything a shopper can reach is scoped to the session's own customer, so no
 * handler here takes a customer id from the request. That is the property that
 * makes the storefront safe to point at live data: the only way to name a
 * customer is to be signed in as them.
 */

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

export function registerShopRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Public: the catalogue is browsable without an account, like a real shop.
  app.get('/api/shop/products', () => ({ products: listProducts(ctx.db) }));

  app.get('/api/shop/demo-accounts', () => ({ accounts: listDemoUsers(ctx.db) }));

  app.post('/api/shop/register', (request, reply) => {
    const body = parseBody(RegisterSchema, request.body);
    const user = createUser(ctx.db, body, ctx.now());
    const session = startSession(ctx.db, user, ctx.now());
    setSessionCookie(reply, session.token);
    return reply.code(201).send({ user: session.user });
  });

  app.post('/api/shop/login', (request, reply) => {
    const body = parseBody(LoginSchema, request.body);
    const user = authenticate(ctx.db, body.email, body.password);
    const session = startSession(ctx.db, user, ctx.now());
    setSessionCookie(reply, session.token);
    return { user: session.user };
  });

  app.post('/api/shop/demo-login', (request, reply) => {
    const body = parseBody(DemoSchema, request.body);
    // Demo sign-in is a passwordless shortcut by design, so it is restricted to
    // accounts the seed marked as demo. Otherwise it would be a backdoor into
    // every real account created in the database.
    const demo = listDemoUsers(ctx.db).find((u) => u.email === body.email.trim().toLowerCase());
    if (demo === undefined) {
      throw badRequest('that is not a demo account');
    }
    const session = startSession(ctx.db, demo, ctx.now());
    setSessionCookie(reply, session.token);
    return { user: session.user };
  });

  app.post('/api/shop/logout', (request, reply) => {
    const cookies = request.cookies as Record<string, string | undefined>;
    endSession(ctx.db, cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/shop/me', (request) => {
    const user = currentUser(request, ctx);
    return user === null ? { user: null } : { user };
  });

  app.get('/api/shop/orders', (request) => {
    const user = currentUser(request, ctx);
    if (user === null) {
      return { user: null, orders: [] };
    }
    return { user, orders: listOrdersForCustomer(ctx.db, user.customerId) };
  });

  app.post('/api/shop/checkout', (request, reply) => {
    const body = parseBody(CheckoutSchema, request.body);
    const user = currentUser(request, ctx);
    if (user === null) {
      throw new UnauthorizedError('sign in to check out');
    }
    const order = checkout(ctx.db, user.customerId, body.lines, ctx.now());
    return reply.code(201).send({ order });
  });
}
