import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  TEST_SECRET,
  TEST_NOW,
  appHarness,
  testEnv,
  type AppHarness,
} from './helpers.js';
import { adminEnabled, adminSigningKey, PLACEHOLDER_ADMIN_PASSWORD, readEnv } from '../config/env.js';
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS } from '../auth/session.js';
import { mintToken } from '../auth/tokens.js';

/**
 * The staff console as a thing that can be switched off.
 *
 * Most of this project's security argument is about the controls inside a
 * request: the resolver, the fact gates, the override rules. This file covers the
 * one control that is not about a request at all - whether the console is there -
 * and it matters more than it looks, because a gate that is open by default is
 * not a gate. A deployment that has never been configured should have no admin
 * surface to find, which is a different and stronger claim than "the admin
 * surface rejects the credential you did not set".
 *
 * The rest covers the sign-in that replaces the pasted token: one account, from
 * the environment, exchanged for a cookie, with a session that carries the same
 * authority a minted token does.
 */

interface ErrorBody {
  readonly error: string;
  readonly message: string;
}

/** A harness whose deployment has no operator account configured. */
async function unconfiguredHarness(): Promise<AppHarness> {
  return appHarness({ kind: 'heuristic' }, testEnv({ ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined }));
}

/** The one staff route every other test in this file reaches for. */
const STAFF_ROUTE = '/api/requests';

describe('a deployment with no operator account', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await unconfiguredHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('reports the console as not enabled', () => {
    expect(adminEnabled(testEnv({ ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined }))).toBe(false);
  });

  it('says so on the health endpoint the client reads', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ adminEnabled: boolean }>().adminEnabled).toBe(false);
  });

  it('answers 404 for a staff route, not 401', async () => {
    // 404 rather than 401 because 401 would confirm that an admin area is
    // contemplated here, which is the one thing an unconfigured deployment
    // should not be leaking.
    const response = await harness.app.inject({ method: 'GET', url: STAFF_ROUTE });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error).toBe('not_found');
  });

  it('answers 404 even with a correctly signed token', async () => {
    // The strongest version of the guarantee: a valid credential is not enough.
    // If the console is not configured there is nothing for a token to be
    // authorised against, and no key in the world should open it.
    const token = mintToken(adminSigningKey(testEnv()), 'mallory', 'admin', 60_000, TEST_NOW);
    const response = await harness.app.inject({
      method: 'GET',
      url: STAFF_ROUTE,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('has no sign-in endpoint either', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(404);
  });

  it('still serves the product', async () => {
    // Switching the console off must not switch the shop off. The reason to
    // disable rather than crash is precisely that a running product can queue
    // work for a person; a refused process cannot.
    const response = await harness.app.inject({ method: 'GET', url: '/api/shop/products' });

    expect(response.statusCode).toBe(200);
  });

  it('still serves the published policy', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/policy' });

    expect(response.statusCode).toBe(200);
  });
});

describe('signing in', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await appHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function login(username: string, password: string): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username, password },
    });
  }

  /** Pulls the session cookie out of a login response, header and all. */
  function sessionCookie(response: LightMyRequestResponse): string {
    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join(';') : String(header ?? '');
    expect(raw).toContain(ADMIN_SESSION_COOKIE);
    return raw;
  }

  it('sets an httpOnly session cookie for the right credentials', async () => {
    const response = await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);

    expect(response.statusCode).toBe(200);
    const cookie = sessionCookie(response);
    // httpOnly is the whole reason for a session over the pasted token: a script
    // injected into the storefront cannot read this and replay it.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('grants that session the same access a minted token has', async () => {
    const cookie = sessionCookie(await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD));
    const response = await harness.app.inject({
      method: 'GET',
      url: STAFF_ROUTE,
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('reaches admin-only routes, not just the readable ones', async () => {
    // Read access alone would not prove the session is an admin session, and the
    // difference between the two roles is the entire point of the override gate.
    const cookie = sessionCookie(await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD));
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('identifies the session in the audit trail by username, not by a token id', async () => {
    const response = await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);

    expect(response.json<{ username: string; role: string }>()).toEqual({
      username: TEST_ADMIN_USERNAME,
      role: 'admin',
    });
  });

  it('rejects a wrong password', async () => {
    const response = await login(TEST_ADMIN_USERNAME, 'not-the-password');

    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong username', async () => {
    const response = await login('not-the-operator', TEST_ADMIN_PASSWORD);

    expect(response.statusCode).toBe(401);
  });

  it('says the same thing about either half being wrong', async () => {
    // Otherwise the endpoint is a username oracle, and "is there an operator
    // account here" is not something an anonymous caller should be able to learn.
    const wrongPassword = await login(TEST_ADMIN_USERNAME, 'nope');
    const wrongUsername = await login('nope', TEST_ADMIN_PASSWORD);

    expect(wrongPassword.json<ErrorBody>()).toEqual(wrongUsername.json<ErrorBody>());
  });

  it('rejects a request with no body rather than signing anyone in', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/api/admin/login', payload: {} });

    expect(response.statusCode).toBe(400);
  });

  it('signs a session that expires', async () => {
    const cookie = sessionCookie(await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD));
    const token = decodeCookie(cookie.split(';')[0] ?? '');

    // Eight hours is a shift. Asserted rather than trusted, because an
    // accidentally unbounded session is the kind of thing nobody notices until
    // it is exploited.
    expect(ADMIN_SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
    const payload = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
      exp: number;
      sub: string;
    };
    expect(payload.sub).toBe(TEST_ADMIN_USERNAME);
    expect(payload.exp).toBe(Math.floor((TEST_NOW.getTime() + ADMIN_SESSION_TTL_MS) / 1000));
  });

  it('tells the browser to drop the session on sign out', async () => {
    const cookie = sessionCookie(await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD));
    const session = cookie.split(';')[0] ?? '';

    const logout = await harness.app.inject({ method: 'POST', url: '/api/admin/logout' });
    expect(logout.statusCode).toBe(200);
    const cleared = String(logout.headers['set-cookie'] ?? '');
    expect(cleared).toContain(ADMIN_SESSION_COOKIE);
    // Empty value, same flags. The flags matter: a cookie cleared with different
    // attributes than it was set with is not cleared, and "sign out" would
    // silently leave the operator signed in.
    expect(cleared).toMatch(/admin_session=;/);

    // The limitation, asserted rather than described. A stateless session cannot
    // be recalled - a copy taken before sign out still verifies until it expires
    // or the signing key changes. It is the price of not keeping a second table
    // of staff credentials, and it is bounded by the eight-hour TTL.
    const replayed = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: session },
    });
    expect(replayed.statusCode).toBe(200);
  });

  it('reports no session before sign in, and one after', async () => {
    const before = await harness.app.inject({ method: 'GET', url: '/api/admin/session' });
    expect(before.statusCode).toBe(401);

    const cookie = sessionCookie(await login(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD));
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: cookie.split(';')[0] ?? '' },
    });

    expect(after.statusCode).toBe(200);
    expect(after.json<{ username: string }>().username).toBe(TEST_ADMIN_USERNAME);
  });

  it('rejects a cookie signed with the wrong key', async () => {
    // The classic session attack: a valid token from some other installation,
    // or one signed before the key was rotated.
    const foreign = mintToken('a-different-key-entirely-32-characters', 'mallory', 'admin', 60_000, TEST_NOW);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${foreign}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const stale = mintToken(adminSigningKey(testEnv()), TEST_ADMIN_USERNAME, 'admin', -1_000, TEST_NOW);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/session',
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${stale}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('the signing key', () => {
  it('prefers the dedicated secret when one is set', () => {
    expect(adminSigningKey(testEnv())).toBe(TEST_SECRET);
  });

  it('is derived from the password when no secret is configured', () => {
    // Two variables are enough to run the console. The derivation is
    // deterministic - otherwise a restart would sign everyone out for no reason
    // - and it is not the password itself, so it is not the password anywhere.
    const env = testEnv({ ADMIN_API_SECRET: undefined });
    const key = adminSigningKey(env);

    expect(key).not.toBe(TEST_ADMIN_PASSWORD);
    expect(key).toHaveLength(64);
    expect(key).toBe(adminSigningKey(env));
  });

  it('changes when the password changes, which signs everyone out', () => {
    const before = adminSigningKey(testEnv({ ADMIN_API_SECRET: undefined }));
    const after = adminSigningKey(
      testEnv({ ADMIN_API_SECRET: undefined, ADMIN_PASSWORD: 'a-different-password-entirely' }),
    );

    expect(after).not.toBe(before);
  });
});

describe('the bundled demo password', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function readEnvWith(extra: Record<string, string>): unknown {
    for (const key of ['NODE_ENV', 'AI_PROVIDER', 'AI_API_KEY', 'ADMIN_API_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
      delete process.env[key];
    }
    // A real file in a real directory, because `readEnv` reads a path and the
    // point of the check is that a file is what a container gets.
    const dir = mkdtempSync(join(tmpdir(), 'admin-env-'));
    const file = join(dir, '.env');
    const body = Object.entries({
      AI_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'nvapi-test-key',
      ...extra,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    writeFileSync(file, body);
    try {
      return readEnv(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('refuses a production deployment still carrying it', () => {
    // It is printed in admin-login.txt and checked into the repository, so in
    // production it is not a secret. Same rule as the placeholder signing key.
    expect(() =>
      readEnvWith({
        NODE_ENV: 'production',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD,
      }),
    ).toThrow(/demo password/);
  });

  it('allows it in development, so the one-command demo works', () => {
    expect(() =>
      readEnvWith({
        NODE_ENV: 'development',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD,
      }),
    ).not.toThrow();
  });
});

/** `name=value` to `value`. */
function decodeCookie(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}
