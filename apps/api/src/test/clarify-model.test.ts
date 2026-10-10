import { describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { processRefundRequest, DEFAULT_DISCRETION } from '../orchestrator.js';
import type { PipelineDeps } from '../orchestrator.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { buildClarifyUser } from '../ai/prompts.js';
import { TEST_NOW } from './helpers.js';

/**
 * The missing detail is derived; only its wording goes to the model.
 *
 * A hardcoded "what has gone wrong" with generic examples answers a billing
 * question with damage probes, because the template cannot see the claim is
 * about a subscription. When a model is available it phrases the ask with the
 * product names and kinds - never money - and the deterministic question stays
 * as the fallback for when there is no model, the call fails, or the wording
 * comes back unusable.
 */

function makeFixture(): { db: Db; customerId: string; orderId: string; mugItemId: string } {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(
    db,
    { email: 'clarify@shop.test', password: 'a-good-password', name: 'Clarify Tester' },
    TEST_NOW,
  );
  const order = checkout(
    db,
    user.customerId,
    [
      { productId: 'PRD-LAMP-01', quantity: 1 },
      { productId: 'PRD-MUG-01', quantity: 1 },
    ],
    TEST_NOW,
  );
  return {
    db,
    customerId: user.customerId,
    orderId: order.id,
    mugItemId: order.items.find((item) => item.name.includes('Mug'))?.itemId ?? '',
  };
}

function makeDeps(analyzer: PipelineDeps['analyzer']): PipelineDeps {
  return { analyzer, injectionAction: 'deny', discretion: DEFAULT_DISCRETION, recordAttempt: () => {} };
}

/** Ask-items double that also phrases, since the real adapters do both. */
function askingAnalyzer(question: string | null) {
  return {
    ...FakeAnalyzer({ kind: 'askItems', candidates: [], then: {} }),
    askClarification: () => Promise.resolve(question),
  };
}

describe('a model-worded clarification', () => {
  it('asks in the model\u2019s words when they are usable', async () => {
    const f = makeFixture();
    const result = await processRefundRequest(
      f.db,
      makeDeps(askingAnalyzer('What can you tell me about the mug - what is wrong with it?')),
      {
        requestId: 'REQ-CLARIFY-1',
        customerId: f.customerId,
        orderId: f.orderId,
        message: 'tell me about the mug',
        itemIds: [f.mugItemId],
        now: TEST_NOW,
      },
    );
    expect(result.stage).toBe('asked');
    if (result.stage !== 'asked') {
      return;
    }
    expect(result.question).toBe('What can you tell me about the mug - what is wrong with it?');
    f.db.close();
  });

  it('falls back to the deterministic question when the wording is unusable', async () => {
    const f = makeFixture();
    const result = await processRefundRequest(f.db, makeDeps(askingAnalyzer('')), {
      requestId: 'REQ-CLARIFY-2',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'tell me about the mug',
      itemIds: [f.mugItemId],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('asked');
    if (result.stage !== 'asked') {
      return;
    }
    expect(result.question).toContain('what has gone wrong');
    f.db.close();
  });

  it('falls back when the analyzer cannot phrase', async () => {
    const f = makeFixture();
    const result = await processRefundRequest(f.db, makeDeps(FakeAnalyzer({ kind: 'askItems', candidates: [], then: {} })), {
      requestId: 'REQ-CLARIFY-3',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'tell me about the mug',
      itemIds: [f.mugItemId],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('asked');
    if (result.stage !== 'asked') {
      return;
    }
    expect(result.question).toContain('what has gone wrong');
    f.db.close();
  });
});

describe('the clarification prompt', () => {
  it('names products and kinds but never money', () => {
    const text = buildClarifyUser({
      field: 'reason',
      items: [{ name: 'Coffee Subscription', kind: 'subscription' }],
      message: 'well i would like to cancel it',
    });
    expect(text).toContain('Coffee Subscription');
    expect(text).toContain('subscription');
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).toContain('cancelling');
  });
});
