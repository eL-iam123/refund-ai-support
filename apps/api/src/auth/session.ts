import type { FastifyReply } from 'fastify';

/**
 * The admin console's browser session.
 *
 * One httpOnly cookie holding the same signed token the CLI mints, so a signed
 * in operator and a scripted call are the same principal as far as every route
 * is concerned - `authenticate` cannot tell them apart and does not need to.
 *
 * The cookie is `httpOnly` and `sameSite=lax`: no script on the page can read
 * it, so a stored cross-site-scripting bug in the storefront cannot walk an
 * operator's session out of the console, and `lax` means it is not attached to a
 * cross-site POST at all. `secure` is set in production only, because the demo
 * is served over plain http on localhost and a secure cookie there is a cookie
 * that is never sent - which looks exactly like a broken login.
 *
 * There is deliberately nothing revocable about it. A stateless token cannot be
 * withdrawn short of changing the signing key, which is why the key is a
 * configuration variable an operator controls and why `ADMIN_API_SECRET` is
 * documented as "rotating this signs everyone out at once". The alternative - a
 * session table like the storefront's - buys revocation at the cost of a second
 * credential store, for a console with a handful of operators. The token is
 * short-lived enough that the difference is small, and the store is one less
 * thing holding staff credentials.
 */

export const ADMIN_SESSION_COOKIE = 'admin_session';

/**
 * How long a browser session lasts. Eight hours: a shift, not a week, and
 * never past the point where somebody should have re-authenticated.
 */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Built per call rather than at module load: `NODE_ENV` is read during config
 * validation, and a constant computed on import would capture whatever the
 * environment happened to say before that ran.
 */
function cookieOptions(maxAge: number): Parameters<FastifyReply['setCookie']>[2] {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  };
}

export function setAdminSession(reply: FastifyReply, token: string): void {
  reply.setCookie(ADMIN_SESSION_COOKIE, token, cookieOptions(ADMIN_SESSION_TTL_MS));
}

export function clearAdminSession(reply: FastifyReply): void {
  // The flags have to match the ones it was set with, or the browser keeps the
  // original and the "sign out" silently does nothing.
  reply.clearCookie(ADMIN_SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
}
