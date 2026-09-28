/**
 * Staff authentication.
 *
 * The reason this exists: an override endpoint that anyone can reach makes every
 * other control in the system decorative. The resolver can be correct, the fact
 * gates can be unbypassable, the grounding can be strict - none of it matters if
 * the caller can simply POST a decision and walk away with the money.
 *
 * Tokens are HMAC-signed with a server-side secret. There is deliberately no HTTP
 * endpoint that mints one: a login route here would be a new attack surface with
 * no identity provider behind it, which is worse than the honest position that
 * credentials are issued out of band by `pnpm --filter @refund/api token`.
 *
 * The format is JWT-shaped but hand-rolled - `base64url(payload).base64url(hmac)` -
 * because a signed blob is all this needs, and a dependency is not.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Two roles, and the difference between them is the point.
 *
 * `agent` reads. `admin` also changes decisions. Splitting read from write is
 * what turns "is this person logged in" into "is this person allowed to do this
 * particular thing", which is the question function-level authorization is
 * actually about.
 */
export const ROLES = ['agent', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  /** The agent's id, e.g. "alice". Appears in the audit trail. */
  readonly subject: string;
  readonly role: Role;
  readonly expiresAt: Date;
}

interface TokenPayload {
  readonly sub: string;
  readonly role: Role;
  /** Unix seconds, as JWT does it. */
  readonly exp: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Issues a token. Server-side only: nothing in the request path calls this. */
export function mintToken(
  secret: string,
  subject: string,
  role: Role,
  ttlMs: number,
  now: Date,
): string {
  const payload: TokenPayload = {
    sub: subject,
    role,
    exp: Math.floor((now.getTime() + ttlMs) / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(secret, encoded)}`;
}

/**
 * Verifies a token or throws.
 *
 * Every rejection returns the same message on purpose. A caller who can tell
 * "expired" from "bad signature" from "not a staff member" learns about the
 * token format, which is a small but free information leak.
 */
export function verifyToken(secret: string, token: string, now: Date): Principal {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new AuthError('invalid credentials', 401, 'unauthorized');
  }
  const [encoded, signature] = parts as [string, string];
  if (!matches(secret, encoded, signature)) {
    throw new AuthError('invalid credentials', 401, 'unauthorized');
  }

  const payload = decode(encoded);
  if (payload === null) {
    throw new AuthError('invalid credentials', 401, 'unauthorized');
  }
  if (payload.exp * 1000 <= now.getTime()) {
    throw new AuthError('invalid credentials', 401, 'unauthorized');
  }
  if (!ROLES.includes(payload.role)) {
    throw new AuthError('invalid credentials', 401, 'unauthorized');
  }

  return { subject: payload.sub, role: payload.role, expiresAt: new Date(payload.exp * 1000) };
}

/** Constant-time comparison, so a wrong signature leaks no timing information. */
function matches(secret: string, encoded: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, encoded), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function decode(encoded: string): TokenPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return isPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Structural check. The signature already proved provenance; this proves shape. */
function isPayload(value: unknown): value is TokenPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sub === 'string' &&
    candidate.sub.length > 0 &&
    typeof candidate.exp === 'number' &&
    typeof candidate.role === 'string'
  );
}

/** Pulls a bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null;
  }
  const token = rest.join(' ').trim();
  return token.length === 0 ? null : token;
}
