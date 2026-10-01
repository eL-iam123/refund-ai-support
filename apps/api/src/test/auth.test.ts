import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { authHeader, scenario, testEnv, TEST_NOW, type AppHarness } from './helpers.js';
import { shopHarness, signIn } from './shop-helpers.js';
import { readEnv } from '../config/env.js';
import { mintToken, verifyToken, AuthError } from '../auth/tokens.js';
import { TEST_SECRET } from './helpers.js';

/**
 * Authorization.
 *
 * An override endpoint anyone can reach makes every other control decorative:
 * the resolver can be correct, the gates unbypassable and the grounding strict,
 * and a caller can still POST the outcome they want. These tests hold the
 * perimeter in place.
 *
 * The four questions, in the order they are asked: is this staff, may they do
 * this, may they touch this object, is the action permitted at all.
 */

interface ErrorBody {
  readonly error: string;
  readonly message: string;
}

/** Loads the real environment with a chosen secret, to prove it is validated. */
function readEnvWithSecret(secret: string): unknown {
  const saved = process.env.ADMIN_API_SECRET;
  process.env.ADMIN_API_SECRET = secret;
  try {
    return readEnv('.env.test-absent');
  } finally {
    if (saved === undefined) {
      delete process.env.ADMIN_API_SECRET;
    } else {
      process.env.ADMIN_API_SECRET = saved;
    }
  }
}

/** Routes that return customer data or mutate decisions. */
const STAFF_ROUTES: readonly { method: 'GET' | 'POST'; url: string; role: 'agent' | 'admin' }[] = [
  { method: 'GET', url: '/api/customers', role: 'admin' },
  { method: 'GET', url: '/api/customers/CUST-AOKAFOR/orders', role: 'agent' },
  { method: 'GET', url: '/api/requests', role: 'agent' },
  { method: 'GET', url: '/api/scenarios', role: 'agent' },
  { method: 'GET', url: '/api/admin/stats', role: 'admin' },
];

describe('staff authorization', () => {
  let harness: AppHarness;
  let shopper: { cookie: string; customerId: string; orderId: string };

  beforeEach(async () => {
    harness = await shopHarness();
    const signedIn = await signIn(harness, 'dana@shop.demo');
    shopper = { cookie: signedIn.cookie, customerId: signedIn.customerId, orderId: signedIn.orderId };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function call(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function makeRequest(): Promise<string> {
    const fixture = scenario('S-01');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: shopper.cookie },
      payload: { customerId: shopper.customerId, orderId: shopper.orderId, message: fixture.message },
    });
    if (response.statusCode !== 201) {
      console.error('makeRequest failed:', response.statusCode, response.body, 'shopper:', shopper);
    }
    expect(response.statusCode).toBe(201);
    return response.json<{ request: { id: string } }>().request.id;
  }

  describe('authentication', () => {
    it('rejects a request with no credentials at all', async () => {
      const response = await call('GET', '/api/requests');

      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error).toBe('unauthorized');
    });

    it('rejects a malformed authorization header', async () => {
      const response = await call('GET', '/api/requests', { authorization: 'Basic abc123' });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const forged = mintToken('a-completely-different-secret-value-32c', 'mallory', 'admin', 60_000, TEST_NOW);
      const response = await call('GET', '/api/requests', { authorization: `Bearer ${forged}` });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a token whose payload was edited after signing', async () => {
      // The signature covers the payload, so promoting yourself to admin by
      // editing the blob must fail. This is the attack the HMAC exists to stop.
      const token = mintToken(TEST_SECRET, 'mallory', 'agent', 60_000, TEST_NOW);
      const [encoded, signature] = token.split('.') as [string, string];
      const promoted = Buffer.from(
        JSON.stringify({ sub: 'mallory', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }),
        'utf8',
      ).toString('base64url');
      const response = await call('GET', '/api/admin/stats', {
        authorization: `Bearer ${promoted}.${signature}`,
      });

      expect(response.statusCode).toBe(401);
      expect(encoded).not.toBe(promoted);
    });

    it('rejects an expired token', async () => {
      const stale = mintToken(TEST_SECRET, 'alice', 'admin', -1_000, TEST_NOW);
      const response = await call('GET', '/api/requests', { authorization: `Bearer ${stale}` });

      expect(response.statusCode).toBe(401);
    });

    it('never says which part of the credential was wrong', async () => {
      const forged = mintToken('a-completely-different-secret-value-32c', 'x', 'admin', 60_000, TEST_NOW);
      const bad = (await call('GET', '/api/requests', { authorization: `Bearer ${forged}` })).json<ErrorBody>();
      const expired = mintToken(TEST_SECRET, 'x', 'admin', -1_000, TEST_NOW);
      const stale = (await call('GET', '/api/requests', { authorization: `Bearer ${expired}` })).json<ErrorBody>();
      const missing = (await call('GET', '/api/requests')).json<ErrorBody>();

      expect(bad.message).toBe(stale.message);
      expect(stale.message).toBe(missing.message);
    });

    it('refuses to start without a usable signing secret', () => {
      // Fail closed: a server that cannot verify a signature must not serve an
      // open admin API, so a short or absent secret is rejected at load time
      // rather than defaulting to something guessable.
      expect(() => testEnv({ ADMIN_API_SECRET: 'too-short' })).not.toThrow();
      expect(() => readEnvWithSecret('too-short')).toThrow(/ADMIN_API_SECRET/);
    });
  });

  describe('function-level authorization', () => {
    it('rejects every staff route without a token', async () => {
      for (const route of STAFF_ROUTES) {
        const response = await call(route.method, route.url);
        expect(`${route.url} ${response.statusCode}`).toBe(`${route.url} 401`);
      }
    });

    it('lets an agent read but not administer', async () => {
      const readable = await call('GET', '/api/requests', { authorization: authHeader('agent') });
      expect(readable.statusCode).toBe(200);

      const forbidden = await call('GET', '/api/admin/stats', { authorization: authHeader('agent') });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json<ErrorBody>().error).toBe('forbidden');
    });

    it('stops an agent from overriding a decision', async () => {
      const id = await makeRequest();
      const response = await call(
        'POST',
        `/api/requests/${id}/override`,
        { authorization: authHeader('agent') },
        { decision: 'denied', note: 'looks fine to me' },
      );

      expect(response.statusCode).toBe(403);
    });

    it('lets an admin override a decision', async () => {
      const id = await makeRequest();
      const response = await call(
        'POST',
        `/api/requests/${id}/override`,
        { authorization: authHeader('admin') },
        { decision: 'denied', note: 'confirmed with fraud team' },
      );

      expect(response.statusCode).toBe(200);
    });

    it('keeps the published policy readable without a token', async () => {
      // Customers are entitled to the rules their refund is judged against.
      const response = await call('GET', '/api/policy');

      expect(response.statusCode).toBe(200);
    });

    it('allows the customer chat endpoint with a valid session', async () => {
      const fixture = scenario('S-01');
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: shopper.cookie },
        payload: { customerId: shopper.customerId, orderId: shopper.orderId, message: fixture.message },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('token primitives', () => {
    it('round-trips a principal', () => {
      const token = mintToken(TEST_SECRET, 'alice', 'admin', 60_000, TEST_NOW);
      const principal = verifyToken(TEST_SECRET, token, TEST_NOW);

      expect(principal.subject).toBe('alice');
      expect(principal.role).toBe('admin');
    });

    it('throws rather than returning a partial principal', () => {
      expect(() => verifyToken(TEST_SECRET, 'not-a-token', TEST_NOW)).toThrow(AuthError);
      expect(() => verifyToken(TEST_SECRET, 'a.b', TEST_NOW)).toThrow(AuthError);
    });
  });

  describe('request cost controls', () => {
    it('rejects an oversized message before it reaches the model', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: shopper.cookie },
        payload: { customerId: shopper.customerId, orderId: shopper.orderId, message: 'x'.repeat(5000) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().message).toContain('too long');
    });
  });
});
