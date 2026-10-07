import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/connection.js';
import type { Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { processRefundRequest, DEFAULT_DISCRETION } from '../orchestrator.js';
import type { ClaimExtraction } from '@refund/shared';
import { recordDialogueTurn } from '../db/dialogue.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import type { PipelineDeps } from '../orchestrator.js';
import { TEST_NOW } from './helpers.js';

const LAMP = 'Aurora Desk Lamp'; // 12900
const MUG = 'Harbour Stoneware Mug'; // 2400

function makeDeps(analyzer: PipelineDeps['analyzer']): PipelineDeps {
  return {
    analyzer,
    injectionAction: 'deny',
    discretion: DEFAULT_DISCRETION,
    recordAttempt: () => {},
  };
}

function makeFixture(): {
  db: Db;
  customerId: string;
  orderId: string;
  lampItemId: string;
  mugItemId: string;
} {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(db, { email: 'consent@shop.test', password: 'a-good-password', name: 'Consent Tester' }, TEST_NOW);
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
    lampItemId: order.items.find((item) => item.name === LAMP)?.itemId ?? '',
    mugItemId: order.items.find((item) => item.name === MUG)?.itemId ?? '',
  };
}

/**
 * A fake that returns the same complete claim on every turn, regardless of history.
 *
 * Used here to force the resolver to reach the consent gate: the model has said the
 * claim, so the resolver can decide, and the question is whether the customer's *own*
 * words cleared the bar before anything is stored.
 */
function fixedAnalyzer(evidenceQuotes: string[], reason: ClaimExtraction['reason'] = 'damaged'): PipelineDeps['analyzer'] {
  return FakeAnalyzer({
    kind: 'fixed',
    extraction: {
      intent: 'refund',
      reason,
      condition: 'damaged',
      confidence: 0.9,
      orderRef: null,
      claimedAmountCents: null,
      items: [],
      evidenceQuotes,
      language: 'en',
      urgency: 'normal',
      policyOverrideAttempted: false,
    },
  });
}

describe('the consent gate', () => {
  let f: ReturnType<typeof makeFixture>;
  let deps: PipelineDeps;

  beforeEach(() => {
    f = makeFixture();
  });

  it('does not gate a stated refund request', async () => {
    deps = makeDeps(fixedAnalyzer(['I want my money back']));
    const result = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-1',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'The lamp arrived broken and I want my money back.',
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    const decided = result.stage === 'decided' ? result : null;
    expect(decided?.decision.decision).toBe('approved');
  });

  it('gates a stated fault with no money ask: a problem is not a remedy request', async () => {
    // Stating "broken" describes what happened; it does not choose between a
    // refund, a replacement, or just reporting it. So even a grounded fault
    // claim comes back as the confirmation question until money is asked for.
    deps = makeDeps(fixedAnalyzer(['The handle is cracked and it is unusable']));
    const result = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-2',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'The handle is cracked and it is unusable.',
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('asked');
    if (result.stage !== 'asked') {
      return;
    }
    expect(result.question).toContain('Before we refund anything:');
  });

  it('asks before storing money on a preference with no stated fault or request', async () => {
    deps = makeDeps(fixedAnalyzer(['the colour is blue, I wanted red']));
    const result = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-3',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'the colour is blue, I wanted red',
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('asked');
    const asked = result.stage === 'asked' ? result : null;
    expect(asked?.question).toContain('Before we refund anything:');
    // The acknowledgement echoes their own words.
    expect(asked?.question).toContain('the colour is blue, I wanted red');
    // A refund is offered only when the policy would approve.
    expect(asked?.question).toContain('a refund of');
  });

  it('records agent_requested_by_customer and escalates when the customer asks for a person', async () => {
    deps = makeDeps(fixedAnalyzer(['the lamp is broken']));
    const result = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-5',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'the lamp is broken and I want to speak to a real person',
      itemIds: [],
      now: TEST_NOW,
    });
    expect(result.stage).toBe('decided');
    const decided = result.stage === 'decided' ? result : null;
    expect(decided?.decision.decision).toBe('escalated');
    const codes = decided?.decision.overrides.map((o) => o.code) ?? [];
    expect(codes).toContain('agent_requested_by_customer');
  });

  it('asks what the customer wants for a wrong item instead of assuming a refund', async () => {
    // The reported transcript: the item picker named the mug, the reason was
    // "different from what I ordered", and the engine approved money nobody
    // asked for. A wrong item might mean a refund, a replacement, or just
    // reporting it, so the problem statement chooses nothing.
    deps = makeDeps(fixedAnalyzer(['it is different from what i ordered'], 'wrong_item'));
    const asked = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-6',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'it is different from what i ordered',
      itemIds: [f.mugItemId],
      now: TEST_NOW,
    });
    expect(asked.stage).toBe('asked');
    if (asked.stage !== 'asked') {
      return;
    }
    expect(asked.question).toContain('Before we refund anything:');
    // Nothing stored: the question is not a decision.
    const stored = f.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(stored.n).toBe(0);

    // "Yes" to the confirmation completes the refund the policy allows.
    recordDialogueTurn(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      customerMessage: 'it is different from what i ordered',
      assistantQuestion: asked.question,
      itemIds: [f.mugItemId],
      now: TEST_NOW,
    });
    const confirmed = await processRefundRequest(f.db, deps, {
      requestId: 'REQ-CONSENT-7',
      customerId: f.customerId,
      orderId: f.orderId,
      message: 'yes please',
      // The picker scope rides with the answer: over HTTP the chat route
      // adopts the confirmation turn's item scope, so the confirmed amount
      // is the offered amount rather than the whole order.
      itemIds: [f.mugItemId],
      now: TEST_NOW,
    });
    expect(confirmed.stage).toBe('decided');
    if (confirmed.stage !== 'decided') {
      return;
    }
    expect(confirmed.decision.decision).toBe('approved');
    expect(confirmed.decision.refundAmountCents).toBe(2400);
  });
});
