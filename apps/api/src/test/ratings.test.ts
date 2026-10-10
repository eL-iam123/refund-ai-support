import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
import { rateReply, ratingsForOrder, RatingError } from '../db/ratings.js';
import { TEST_NOW } from './helpers.js';

/**
 * Verdicts on answers: one row per customer per request.
 *
 * A rating changes nothing about the request - no money, no queue, no reopen -
 * so the tests hold the small contract instead: upsert semantics, ownership,
 * and order scoping.
 */

function fixture() {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(
    db,
    { email: 'rater@shop.test', password: 'a-good-password', name: 'Rater' },
    TEST_NOW,
  );
  const other = createUser(
    db,
    { email: 'other@shop.test', password: 'a-good-password', name: 'Other' },
    TEST_NOW,
  );
  const order = checkout(
    db,
    user.customerId,
    [{ productId: 'PRD-MUG-01', quantity: 1 }],
    TEST_NOW,
  );
  return { db, user, other, order };
}

function requestRow(customerId: string, orderId: string, requestId: string): NewRequestRow {
  const at = TEST_NOW.toISOString();
  return {
    id: requestId,
    createdAt: at,
    customerId,
    customerName: 'Rater',
    orderId,
    message: 'the mug arrived broken',
    messageSha256: '0'.repeat(64),
    messageFingerprint: '1'.repeat(64),
    decision: 'approved',
    refundAmountCents: 2400,
    eligibleAmountCents: 2400,
    summary: 'fixture',
    policyRef: 'REFUND_POLICY.md §5.1',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: '[]',
    blockedItemsJson: '[]',
    claimItemIdsJson: '[]',
    responseText: 'fixture',
    extractionJson: null,
    groundingJson: null,
    injectionJson: '{"detected":false,"signals":[],"obfuscationNoted":false}',
    aiMode: 'fake',
    llmCalled: false,
    timingsJson: '[]',
    scenarioId: null,
  };
}

describe('rating an answer', () => {
  it('stores a verdict and reads it back for the order', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f.user.customerId, f.order.id, 'REQ-RATE-1'));
    const record = rateReply(f.db, {
      requestId: 'REQ-RATE-1',
      customerId: f.user.customerId,
      rating: 'up',
      now: TEST_NOW,
    });
    expect(record.rating).toBe('up');
    expect(ratingsForOrder(f.db, f.user.customerId, f.order.id)).toMatchObject([
      { requestId: 'REQ-RATE-1', rating: 'up' },
    ]);
    f.db.close();
  });

  it('replaces a changed mind instead of stacking rows', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f.user.customerId, f.order.id, 'REQ-RATE-1'));
    rateReply(f.db, { requestId: 'REQ-RATE-1', customerId: f.user.customerId, rating: 'up', now: TEST_NOW });
    const changed = rateReply(f.db, {
      requestId: 'REQ-RATE-1',
      customerId: f.user.customerId,
      rating: 'down',
      now: TEST_NOW,
    });
    expect(changed.rating).toBe('down');
    expect(ratingsForOrder(f.db, f.user.customerId, f.order.id)).toHaveLength(1);
    f.db.close();
  });

  it('refuses a verdict on someone else\u2019s answer', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f.user.customerId, f.order.id, 'REQ-RATE-1'));
    expect(() =>
      rateReply(f.db, { requestId: 'REQ-RATE-1', customerId: f.other.customerId, rating: 'up', now: TEST_NOW }),
    ).toThrow(RatingError);
    f.db.close();
  });

  it('refuses a verdict on a request that does not exist', () => {
    const f = fixture();
    expect(() =>
      rateReply(f.db, { requestId: 'REQ-NOPE', customerId: f.user.customerId, rating: 'up', now: TEST_NOW }),
    ).toThrow(RatingError);
    f.db.close();
  });

  it('scopes the list to the order', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f.user.customerId, f.order.id, 'REQ-RATE-1'));
    rateReply(f.db, { requestId: 'REQ-RATE-1', customerId: f.user.customerId, rating: 'up', now: TEST_NOW });
    expect(ratingsForOrder(f.db, f.user.customerId, 'ORD-ELSEWHERE')).toEqual([]);
    f.db.close();
  });
});
