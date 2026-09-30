import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { appHarness, TEST_NOW, TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME, type AppHarness } from './helpers.js';
import { seedRequestHistory } from '../db/seedHistory.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import type { PipelineDeps } from '../orchestrator.js';

/**
 * Where a request came from.
 *
 * The desktop console replays curated scenarios; the storefront takes real
 * customers. Both produce `refund_requests` rows, and the difference matters to
 * an operator: a "recent claims" list full of demo runs is not a queue. Every
 * DTO carries `source`, and the list endpoint can filter on it.
 *
 * The tag is derived from a fact about the row (`scenario_id IS NULL`), not
 * written at persistence time, so there is no field a caller could get wrong:
 * a seeded demo run can never be told to masquerade as a live claim.
 */
describe('provenance: which surface a request came from', () => {
  let harness: AppHarness;
  let sessionCookie: string;

  beforeEach(async () => {
    harness = await appHarness();
    // Production boot runs the curated scenario history through the real
    // pipeline so the console opens onto genuine rows. The harness does not, so
    // the one thing this file is about - the two surfaces sharing the table -
    // has to be set up here. The heuristic analyzer keeps the seed deterministic
    // (no model, no network).
    const pipeline: PipelineDeps = {
      analyzer: FakeAnalyzer(),
      recordAttempt: () => {},
      injectionAction: 'deny',
    };
    await seedRequestHistory(harness.db, TEST_NOW, pipeline);
    sessionCookie = '';
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function signIn(): Promise<void> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join(';') : String(header ?? '');
    sessionCookie = raw.split(';')[0] ?? '';
  }

  function list(source?: string): Promise<LightMyRequestResponse> {
    const query = source === undefined ? '' : `?source=${encodeURIComponent(source)}&limit=100`;
    return harness.app.inject({
      method: 'GET',
      url: `/api/requests${query}`,
      headers: { cookie: sessionCookie },
    });
  }

  it('marks the seeded demo history as scenario-sourced', async () => {
    await signIn();

    const response = await list('scenario');

    expect(response.statusCode).toBe(200);
    const { requests } = response.json<{
      requests: readonly { readonly id: string; readonly source: string }[];
    }>();
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (const request of requests) {
      expect(request.source).toBe('scenario');
      expect(request.id).not.toBe('');
    }
  });

  it('starts with no storefront rows, then tags a live request as one', async () => {
    await signIn();

    const before = await list('storefront');
    expect(before.json<{ requests: readonly unknown[] }>().requests).toHaveLength(0);

    // A real order request resolves deterministically and R-02 denies it - the
    // cells are final sale, so the decision needs no model to be correct.
    const live = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { customerId: 'CUST-CASTELLANOS', message: 'The Studio Headphones came in the wrong colour, I do not want them.' },
    });
    expect(live.statusCode).toBe(201);
    const created = live.json<{ request: { id: string; orderId: string; decision: { decision: string }; source: string } }>().request;

    expect(created.source).toBe('storefront');
    expect(created.orderId).toBe('ORD-1003');
    expect(created.decision.decision).toBe('denied');

    const storefront = await list('storefront');
    const storefrontIds = storefront
      .json<{ requests: readonly { id: string; source: string }[] }>()
      .requests;
    expect(storefrontIds.map((row) => row.id)).toContain(created.id);
    expect(storefrontIds.find((row) => row.id === created.id)?.source).toBe('storefront');

    // The demo history is untouched by the live arrival.
    const scenario = await list('scenario');
    const scenarioIds = scenario.json<{ requests: readonly { id: string }[] }>().requests.map((row) => row.id);
    expect(scenarioIds).not.toContain(created.id);
  });

  it('shows the tag on the unfiltered list so it cannot be mistaken', async () => {
    await signIn();

    const live = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { customerId: 'CUST-CASTELLANOS', message: 'The headphones are the wrong colour, I changed my mind.' },
    });
    const createdId = live.json<{ request: { id: string } }>().request.id;

    const response = await list();
    const { requests } = response.json<{
      requests: readonly { id: string; source: string }[];
    }>();

    const liveRow = requests.find((row) => row.id === createdId);
    expect(liveRow?.source).toBe('storefront');
    expect(requests).toContainEqual(expect.objectContaining({ source: 'scenario' }));
  });

  it('rejects a source that is not a surface', async () => {
    await signIn();

    const response = await list('snapshot');

    expect(response.statusCode).toBe(400);
  });
});