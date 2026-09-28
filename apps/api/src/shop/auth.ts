import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/connection.js';

/**
 * Storefront accounts and sessions.
 *
 * Two deliberate choices.
 *
 * Passwords are scrypt-hashed with a per-user salt rather than being compared
 * directly. A demo shop still ends up holding real people's email addresses and
 * whatever password they reused, so the cheap option is not actually cheaper.
 *
 * Sessions are opaque random tokens, and only the SHA-256 of the token is
 * stored. Signing would make the cookie self-validating but forgeable-then-
 * revocable only by rotating a secret; a random token the database has never
 * seen simply cannot authenticate anybody. It also means logout is real, which
 * a stateless token cannot offer.
 *
 * Note what this is *not*: the refund endpoint's `customerId` in the request
 * body is still the customer's assertion, not a verified claim. Signing in here
 * does not, on its own, close that gap. See `resolveShopSession` usage in the
 * chat route for the one place the two are reconciled.
 */

const KEY_LENGTH = 64;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'shop_session';

export interface ShopUser {
  readonly id: string;
  readonly email: string;
  readonly customerId: string;
  readonly isDemo: boolean;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  customer_id: string;
  is_demo: number;
}

export class ShopAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 409 = 400,
  ) {
    super(message);
    this.name = 'ShopAuthError';
  }
}

/** Hashes a password with a fresh salt, returning both halves for storage. */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  return { hash: scryptSync(password, salt, KEY_LENGTH).toString('hex'), salt };
}

/**
 * Verifies a password in constant time.
 *
 * A wrong password still pays for a scrypt call: returning early on the length
 * check would leak, through timing, whether the stored hash is what was
 * supplied - and "the account exists" versus "the password is wrong" is already
 * something the caller is told, so the timing channel would add little. The
 * point is to not make hash comparison itself the fast path.
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toUser(row: UserRow): ShopUser {
  return {
    id: row.id,
    email: row.email,
    customerId: row.customer_id,
    isDemo: row.is_demo === 1,
  };
}

/** Creates an account plus the customer record its orders hang off. */
export function createUser(
  db: Db,
  input: { email: string; password: string; name: string; isDemo?: boolean },
  now: Date,
): ShopUser {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ShopAuthError('enter a valid email address');
  }
  if (input.password.length < 8) {
    throw new ShopAuthError('use a password of at least 8 characters');
  }
  const existing = db.prepare('SELECT id FROM shop_users WHERE email = ?').get(email) as
    | { id: string }
    | undefined;
  if (existing !== undefined) {
    throw new ShopAuthError('that email is already registered', 409);
  }

  const { hash, salt } = hashPassword(input.password);
  const userId = `USR-${randomUUID()}`;
  const customerId = `CUST-${randomUUID()}`;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO customers (id, name, email, tier, account_created_at, prior_refund_count, refund_requests_last_30d)
       VALUES (?, ?, ?, 'standard', ?, 0, 0)`,
    ).run(customerId, input.name.trim() || (email.split('@')[0] ?? 'Shopper'), email, now.toISOString());
    db.prepare(
      `INSERT INTO shop_users (id, email, password_hash, password_salt, customer_id, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, email, hash, salt, customerId, input.isDemo === true ? 1 : 0, now.toISOString());
  })();

  return { id: userId, email, customerId, isDemo: input.isDemo === true };
}

/**
 * Signs in.
 *
 * The same message covers "no such account" and "wrong password" so the endpoint
 * cannot be used to enumerate who has registered.
 */
export function authenticate(db: Db, email: string, password: string): ShopUser {
  const row = db.prepare('SELECT * FROM shop_users WHERE email = ?').get(email.trim().toLowerCase()) as
    | UserRow
    | undefined;
  if (row === undefined || !verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new ShopAuthError('email or password is not correct', 401);
  }
  return toUser(row);
}

function insertSession(db: Db, userId: string, now: Date): string {
  const token = randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO shop_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_TTL_MS).toISOString());
  return token;
}

/** Signs a user in, returning the cookie token and the user. */
export function startSession(
  db: Db,
  user: ShopUser,
  now: Date,
): { token: string; user: ShopUser } {
  const row = db.prepare('SELECT id FROM shop_users WHERE id = ?').get(user.id) as { id: string } | undefined;
  if (row === undefined) {
    throw new ShopAuthError('account not found', 401);
  }
  return { token: insertSession(db, user.id, now), user };
}

/** Resolves a cookie token to its user, or null. Expired sessions are deleted. */
export function resolveShopSession(db: Db, token: string | undefined, now: Date): ShopUser | null {
  if (token === undefined || token.length === 0) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT u.* FROM shop_sessions s
         JOIN shop_users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now.toISOString()) as UserRow | undefined;
  return row === undefined ? null : toUser(row);
}

export function endSession(db: Db, token: string | undefined): void {
  if (token === undefined || token.length === 0) {
    return;
  }
  db.prepare('DELETE FROM shop_sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Removes expired rows. Called on boot so a long-lived server does not grow. */
export function purgeExpiredSessions(db: Db, now: Date): number {
  const result = db.prepare('DELETE FROM shop_sessions WHERE expires_at <= ?').run(now.toISOString());
  return result.changes;
}

/** The accounts offered as one-click demo logins. */
export function listDemoUsers(db: Db): readonly ShopUser[] {
  const rows = db
    .prepare('SELECT * FROM shop_users WHERE is_demo = 1 ORDER BY email')
    .all() as UserRow[];
  return rows.map(toUser);
}
