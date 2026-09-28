/**
 * Authorization as four separate questions, answered in order.
 *
 *   1. Is this a staff member at all?        -> `authenticate`
 *   2. May they perform this action?         -> `requireRole`
 *   3. May they touch this specific object?  -> object checks in the route
 *   4. Is the action itself permitted?       -> the route existing at all
 *
 * Steps 1 and 2 are here. Step 3 is deliberately left in the routes, because it
 * is the one that has to know what the object is - and a generic guard that
 * "checked authorization" without ever looking at the row is exactly the BOLA
 * bug this system already had once.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError, bearerFrom, type Principal, type Role, verifyToken } from './tokens.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only on routes behind `authenticate`. */
    principal?: Principal;
  }
}

/** Maps a token failure onto the HTTP errors, without leaking which check failed. */
function toHttp(error: unknown): Error {
  if (error instanceof AuthError) {
    return error.statusCode === 403
      ? new ForbiddenError('this action requires a higher role')
      : new UnauthorizedError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Step 1. Rejects anything without a valid, unexpired staff token. */
export function authenticate(secret: string, now: () => Date) {
  return (request: FastifyRequest): void => {
    const token = bearerFrom(request.headers.authorization);
    if (token === null) {
      throw new UnauthorizedError();
    }
    try {
      request.principal = verifyToken(secret, token, now());
    } catch (error: unknown) {
      throw toHttp(error);
    }
  };
}

/**
 * Step 2. The action gate.
 *
 * `admin` implies `agent`, so a supervisor is not locked out of read-only views
 * by their own higher role. That direction is safe: every additional capability
 * an admin has is one the role was defined to include.
 */
export function requireRole(role: Role) {
  return (request: FastifyRequest): void => {
    const principal = request.principal;
    if (principal === undefined) {
      throw new UnauthorizedError();
    }
    if (principal.role !== role && !(role === 'agent' && principal.role === 'admin')) {
      throw new ForbiddenError(`this action requires the ${role} role`);
    }
  };
}

/**
 * Convenience: authenticate and authorize in one preHandler.
 *
 * Returns a promise rather than throwing synchronously. Both guards are
 * synchronous functions, but a preHandler that throws on the call stack unwinds
 * past Fastify's handler chain, so the rejection is deferred deliberately - the
 * error handler has to see it to turn it into a 401.
 */
export function staffOnly(secret: string, role: Role, now: () => Date) {
  const verify = authenticate(secret, now);
  const permit = requireRole(role);
  return (request: FastifyRequest): Promise<void> =>
    Promise.resolve().then(() => {
      verify(request);
      permit(request);
    });
}

/**
 * Declares `principal` on the request. Registered once at startup; every route
 * that sets it goes through a guard.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('principal', undefined);
}
