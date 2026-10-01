import { afterEach, describe, expect, it } from 'vitest';
import { appHarness, testEnv, type AppHarness } from './helpers.js';

describe('reported HTTP boundary regressions', () => {
  const harnesses: AppHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(async ({ app, db }) => {
      await app.close();
      db.close();
    }));
  });

  it('requires a customer session before creating a refund request', async () => {
    const h = await appHarness();
    harnesses.push(h);
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { customerId: 'CUST-1', orderId: 'ORD-1', message: 'I want my money back' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toBe('unauthorized');
    expect(h.db.prepare('SELECT COUNT(*) AS count FROM refund_requests').get()).toMatchObject({ count: 0 });
  });

  it('rate limits health and login requests', async () => {
    const h = await appHarness(undefined, testEnv({ RATE_LIMIT_MAX: 2 }));
    harnesses.push(h);
    const health = () => h.app.inject({ method: 'GET', url: '/api/health' });
    expect((await health()).statusCode).toBe(200);
    expect((await health()).statusCode).toBe(200);
    expect((await health()).statusCode).toBe(429);

    const login = () => h.app.inject({
      method: 'POST',
      url: '/api/shop/login',
      payload: { email: 'sam@shop.demo', password: 'nope' },
    });
    expect((await login()).statusCode).toBe(429);
  });

  it('returns 400 for malformed JSON and 413 for oversized JSON', async () => {
    const h = await appHarness();
    harnesses.push(h);
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/shop/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('bad_request');

    const big = await h.app.inject({
      method: 'POST',
      url: '/api/shop/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(70 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ error: string }>().error).toBe('payload_too_large');
  });
});
