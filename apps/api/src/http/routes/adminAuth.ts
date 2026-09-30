import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminCredentials, adminEnabled, adminSigningKey } from '../../config/env.js';
import type { AppContext } from '../context.js';
import { mintToken } from '../../auth/tokens.js';
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS, clearAdminSession, setAdminSession } from '../../auth/session.js';
import { authenticate } from '../../auth/guards.js';
import { UnauthorizedError, badRequest } from '../errors.js';

/**
 * Signing in to the admin console.
 *
 * This is the endpoint the rest of this project's design has been careful to
 * avoid, so it is worth being blunt about why it is here and why it is bounded.
 *
 * The alternative - staff pasting a token minted by a CLI - is authentication
 * without an identity. It cannot support a session, it cannot be revoked, and
 * it means the person in front of the browser is not a user the system has ever
 * heard of. For a console whose whole job is "a human looked at this and decided",
 * that is the wrong shape: the audit trail records a token subject nobody chose.
 *
 * So this exists, and what it is allowed to be is deliberately small:
 *
 *   - One account. Not a user store, not registration, not invitations. There is
 *     no way to create an account from over the network, so this endpoint cannot
 *     be used to grow the set of people who can reach the console.
 *   - The credential comes from the environment, never from the database, so
 *     there is no table to inject into and nothing to leak from a backup.
 *   - Comparison is constant time, so neither the username nor the password can
 *     be recovered by timing a request.
 *   - Failure says one thing for both halves, so it cannot be used to find out
 *     whether an operator account exists.
 *   - It yields a session cookie and nothing else: no token in the response body
 *     for a script to leak into a log, and no refresh mechanism, so there is no
 *     long-lived credential anywhere in the browser.
 *
 * Behind an identity provider this whole file disappears, which is the point of
 * writing it this narrowly.
 */

const LoginBody = z.object({
  username: z.string().min(1, 'enter a username'),
  password: z.string().min(1, 'enter a password'),
});

/**
 * Hashes first, then compares.
 *
 * `timingSafeEqual` throws on a length mismatch, and the raw lengths are the
 * thing being protected, so both sides are hashed to a fixed width before the
 * comparison. SHA-256 is not a password hash and is not being used as one - it
 * is here only to turn a variable-length secret into a fixed-length one so the
 * comparison cannot leak length.
 */
function matches(expected: string, supplied: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(a, b);
}

export function registerAdminAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * The console's own answer to "am I signed in, and may this deployment have a
   * console at all".
   *
   * The client reads it before rendering anything, which is why it carries
   * `adminEnabled`: a deployment that has not configured a console should show
   * no sign-in form, because a form that cannot ever succeed is a worse thing to
   * leave on screen than no console.
   */
  app.get('/api/admin/session', (request, reply) => {
    if (!adminEnabled(ctx.env)) {
      return reply.code(404).send({ error: 'not_found', message: 'not found' });
    }
    if (request.cookies[ADMIN_SESSION_COOKIE] === undefined) {
      return reply.code(401).send({ error: 'unauthorized', message: 'authentication is required' });
    }
    // Verified with the real guard, so "signed in" here means the same thing it
    // means at every route that will act on the session.
    authenticate(adminSigningKey(ctx.env), ctx.now)(request);
    return reply.send({
      username: request.principal?.subject ?? '',
      role: request.principal?.role ?? 'agent',
      expiresAt: request.principal?.expiresAt.toISOString() ?? '',
    });
  });

  app.post('/api/admin/login', (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'username and password are required');
    }
    const credentials = adminCredentials(ctx.env);
    if (credentials === null) {
      // Not a 403 and not a hint. An unconfigured deployment does not have a
      // console, so the sign-in endpoint is simply not there.
      return reply.code(404).send({ error: 'not_found', message: 'not found' });
    }
    if (
      !matches(credentials.username, parsed.data.username) ||
      !matches(credentials.password, parsed.data.password)
    ) {
      // One message for a wrong username, a wrong password and an account that
      // does not exist: the caller learns nothing it could enumerate with.
      throw new UnauthorizedError('username or password is not correct');
    }

    const token = mintToken(
      adminSigningKey(ctx.env),
      credentials.username,
      'admin',
      ADMIN_SESSION_TTL_MS,
      ctx.now(),
    );
    setAdminSession(reply, token);
    ctx.log.info({ username: credentials.username }, 'admin.login');
    return reply.send({ username: credentials.username, role: 'admin' as const });
  });

  /**
   * Signs out.
   *
   * Clears the cookie and nothing else, which is the whole of what a stateless
   * session can revoke. The token stays valid until it expires or the signing key
   * changes, and saying so in the UI is better than implying a stronger guarantee
   * than the design has.
   */
  app.post('/api/admin/logout', (_request, reply) => {
    clearAdminSession(reply);
    return reply.send({ ok: true });
  });
}
