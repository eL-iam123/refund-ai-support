import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ShopAnswerDto } from '@refund/shared';
import { appHarness, TEST_NOW, testEnv, type AppHarness } from './helpers.js';
import { seedShop } from '../shop/seed.js';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { createAttemptRecorder } from '../db/attemptRecorder.js';
import { buildApp } from '../http/app.js';
import { silentLogger } from '../lib/logger.js';
import { DEFAULT_DISCRETION } from '../orchestrator.js';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type AttemptObserver,
  type ChatInput,
  type ChatReply,
  type IntakeInput,
  type IntakeReply,
  type ShopInput,
  type ShopSuggestion,
} from '../ai/analyzer.js';

/**
 * The shopping assistant end to end.
 *
 * Three properties matter, in order: a shop turn never writes a refund row or
 * reserves ledger money; nominated ids are re-validated so a bogus id is
 * dropped rather than shown; and a claim typed in shopping mode still runs
 * the refund pipeline. Everything else is wording.
 */
describe('shopping assistant', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function signIn(): Promise<{ cookie: string; customerId: string; orderId: string }> {
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/shop/login',
      payload: { email: 'sam@shop.demo', password: 'refund-demo-2026' },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
    const { user } = login.json<{ user: { customerId: string } }>();

    const products = await harness.app.inject({ method: 'GET', url: '/api/shop/products' });
    const { products: catalogue } = products.json<{ products: readonly { id: string }[] }>();
    const checkout = await harness.app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie },
      payload: { lines: [{ productId: catalogue[0]?.id ?? '', quantity: 1 }] },
    });
    expect(checkout.statusCode).toBe(201);
    return { cookie, customerId: user.customerId, orderId: checkout.json<{ order: { id: string } }>().order.id };
  }

  function send(cookie: string, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return harness.app.inject({ method: 'POST', url: '/api/chat/messages', headers: { cookie }, payload: body });
  }

  function counts(db: Db): { requests: number; refunds: number; shopTurns: number } {
    const requests = db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    const refunds = db.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number };
    const shopTurns = db.prepare('SELECT COUNT(*) AS n FROM shop_assistant_turns').get() as { n: number };
    return { requests: requests.n, refunds: refunds.n, shopTurns: shopTurns.n };
  }

  it('answers order status without writing a refund row', async () => {
    const { cookie, customerId, orderId } = await signIn();
    const before = counts(harness.db);

    const response = await send(cookie, { customerId, orderId, message: 'where is my order?', shopping: true });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ shopAnswer: ShopAnswerDto }>();
    expect(body.shopAnswer.kind).toBe('order_status');
    expect(body.shopAnswer.orderStatus?.orderId).toBe(orderId);
    expect(body.shopAnswer.answer).toContain(orderId);

    const after = counts(harness.db);
    expect(after.requests).toBe(before.requests);
    expect(after.refunds).toBe(before.refunds);
    expect(after.shopTurns).toBe(before.shopTurns + 1);
  });

  it('answers return logistics and browsing from keyword search with no model', async () => {
    const { cookie, customerId } = await signIn();

    const logistics = await send(cookie, { customerId, orderId: null, message: 'how do I send it back?', shopping: true });
    expect(logistics.statusCode).toBe(201);
    expect(logistics.json<{ shopAnswer: ShopAnswerDto }>().shopAnswer.kind).toBe('return_help');

    // The heuristic test analyzer nominates nothing, so the FTS index answers.
    const browsing = await send(cookie, { customerId, orderId: null, message: 'do you sell kettles?', shopping: true });
    expect(browsing.statusCode).toBe(201);
    const answer = browsing.json<{ shopAnswer: ShopAnswerDto }>().shopAnswer;
    expect(answer.kind).toBe('product_help');
    expect(answer.products.map((card) => card.id)).toContain('PRD-KETTLE-01');
    const kettle = answer.products.find((card) => card.id === 'PRD-KETTLE-01');
    expect(kettle?.priceCents).toBe(8900);
  });

  it('still runs the refund pipeline for a claim typed in shopping mode', async () => {
    const { cookie, customerId, orderId } = await signIn();
    const before = counts(harness.db);

    const response = await send(cookie, { customerId, orderId, message: 'the lamp arrived broken', shopping: true });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ request: { id: string; decision: { decision: string } } }>();
    expect(typeof body.request.id).toBe('string');
    expect(typeof body.request.decision.decision).toBe('string');

    const after = counts(harness.db);
    expect(after.requests).toBe(before.requests + 1);
    expect(after.shopTurns).toBe(before.shopTurns);
  });

  it('round-trips the shopping thread through its own history', async () => {
    const { cookie, customerId, orderId } = await signIn();
    await send(cookie, { customerId, orderId: null, message: 'do you sell mugs?', shopping: true });
    await send(cookie, { customerId, orderId, message: 'where is my order?', shopping: true });

    const history = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/assistant/history',
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    const { turns } = history.json<{ turns: readonly { message: string; shopAnswer: ShopAnswerDto }[] }>();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.message).toBe('do you sell mugs?');
    expect(turns[1]?.shopAnswer.kind).toBe('order_status');

    // The refund thread is untouched by shopping: no request turns leak in.
    const orderHistory = await harness.app.inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`,
      headers: { cookie },
    });
    expect(orderHistory.statusCode).toBe(200);
    expect(orderHistory.json<{ turns: readonly unknown[] }>().turns).toHaveLength(0);

    const signedOut = await harness.app.inject({ method: 'GET', url: '/api/shop/assistant/history' });
    expect(signedOut.statusCode).toBe(401);
  });

  describe('with a nominating model', () => {
    function stubHarness(suggest: (input: ShopInput) => Promise<ShopSuggestion | null>): Promise<{
      app: FastifyInstance;
      db: Db;
      cookie: string;
      customerId: string;
    }> {
      const db = openMemoryDatabase();
      seedShop(db, TEST_NOW);
      const analyzer: AIAnalyzer = {
        label: 'stub',
        model: 'stub-shop-v1',
        available: true,
        unavailableReason: null,
        analyze(_input: IntakeInput, _observer: AttemptObserver): Promise<IntakeReply> {
          return Promise.reject(new AiUnavailableError('stub never extracts'));
        },
        chat(_input: ChatInput, observer: AttemptObserver): Promise<ChatReply> {
          observer({ model: 'stub-shop-v1', attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });
          return Promise.resolve({ kind: 'text', text: 'stub', model: 'stub-shop-v1' });
        },
        summariseCase: () => Promise.resolve(null),
        suggestProducts(input: ShopInput, observer: AttemptObserver): Promise<ShopSuggestion | null> {
          observer({ model: 'stub-shop-v1', attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });
          return suggest(input);
        },
      };
      return buildApp({
        env: testEnv(),
        db,
        logger: silentLogger,
        now: (): Date => TEST_NOW,
        observeHub: (): void => {},
        pipeline: {
          analyzer,
          recordAttempt: createAttemptRecorder(db),
          injectionAction: 'deny',
          discretion: DEFAULT_DISCRETION,
        },
      })
        .ready()
        .then(async (app) => {
          const login = await app.inject({
            method: 'POST',
            url: '/api/shop/login',
            payload: { email: 'sam@shop.demo', password: 'refund-demo-2026' },
          });
          const raw = login.headers['set-cookie'];
          const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
          return { app, db, cookie, customerId: login.json<{ user: { customerId: string } }>().user.customerId };
        });
    }

    it('drops nominated ids that are not in the catalogue', async () => {
      const { app, cookie, customerId } = await stubHarness(() =>
        Promise.resolve({ productIds: ['PRD-NOPE', 'PRD-MUG-01'], model: 'stub-shop-v1' }),
      );
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/chat/messages',
          headers: { cookie },
          payload: { customerId, orderId: null, message: 'show me mugs', shopping: true },
        });
        expect(response.statusCode).toBe(201);
        const answer = response.json<{ shopAnswer: ShopAnswerDto }>().shopAnswer;
        expect(answer.products.map((card) => card.id)).toEqual(['PRD-MUG-01']);
        expect(answer.answer).not.toContain('NOPE');
      } finally {
        await app.close();
      }
    });

    it('falls back to keyword search when the model fails', async () => {
      const { app, db, cookie, customerId } = await stubHarness(() => Promise.reject(new Error('provider down')));
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/chat/messages',
          headers: { cookie },
          payload: { customerId, orderId: null, message: 'do you sell kettles?', shopping: true },
        });
        expect(response.statusCode).toBe(201);
        const answer = response.json<{ shopAnswer: ShopAnswerDto }>().shopAnswer;
        expect(answer.products.map((card) => card.id)).toContain('PRD-KETTLE-01');
        expect(db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get()).toEqual({ n: 0 });
      } finally {
        await app.close();
      }
    });
  });
});
