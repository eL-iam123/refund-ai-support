import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appHarness, testEnv, TEST_NOW, type AppHarness } from './helpers.js';
import {
  assertDecisionCoherent,
  applyHumanOverride,
  findRequestById,
  insertRequest,
} from '../db/requestRepository.js';
import { IncoherentDecisionError } from '../http/errors.js';
import { createHash } from 'node:crypto';
import type { NewRequestRow } from '../db/requestRepository.js';
import type { Decision } from '@refund/shared';

/**
 * The payable amount cannot be recorded on a row that did not approve it.
 *
 * `refund_requests` is the read model a payout process would read, so the
 * decision/amount pair stored on a row is a money-safety property rather than a
 * display detail. These tests pin it at the two places a row can be written, and
 * they pin the *ordering* too: an invariant asserted after the UPDATE has already
 * committed the bad row, which is the state the check exists to prevent.
 */

describe('decision and amount coherence', () => {
  it('accepts an approval with a positive amount', () => {
    expect(() => assertDecisionCoherent('approved', 12900)).not.toThrow();
  });

  it('rejects an approval with no amount', () => {
    // Approving something worth nothing is how "approved" becomes a badge that
    // costs the business money later.
    expect(() => assertDecisionCoherent('approved', 0)).toThrow(/nothing on this order is eligible/);
  });

  it('rejects a denial carrying money', () => {
    expect(() => assertDecisionCoherent('denied', 12900)).toThrow(/cannot carry a payable amount/);
  });

  it('rejects an escalation carrying money', () => {
    // A human has not looked yet. A positive amount here is an unauthorised
    // payment queued behind a review that may say no.
    expect(() => assertDecisionCoherent('escalated', 70000)).toThrow(/cannot carry a payable amount/);
  });

  it('accepts zero for every non-approval', () => {
    for (const decision of ['denied', 'escalated', 'passed'] as const) {
      expect(() => assertDecisionCoherent(decision as Decision, 0)).not.toThrow();
    }
  });

  it('rejects a negative or fractional amount', () => {
    expect(() => assertDecisionCoherent('approved', -100)).toThrow(/non-negative whole number/);
    expect(() => assertDecisionCoherent('approved', 10.5)).toThrow(/non-negative whole number/);
  });

  it('points an escalation at the field that holds the figure under review', () => {
    // The error is the documentation an on-call engineer reads at 3am.
    expect(() => assertDecisionCoherent('escalated', 70000)).toThrow(/eligible_amount_cents/);
  });
});

describe('the invariant is enforced by the write path', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await appHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function newRow(overrides: Partial<NewRequestRow> = {}): NewRequestRow {
    return {
      id: 'REQ-COHERENCE-1',
      createdAt: TEST_NOW.toISOString(),
      customerId: 'CUST-AOKAFOR',
      customerName: 'Ada Okafor',
      orderId: 'ORD-1001',
      message: 'The mug arrived broken.',
      messageSha256: createHash('sha256').update('The mug arrived broken.', 'utf8').digest('hex'),
      decision: 'approved',
      refundAmountCents: 10000,
      eligibleAmountCents: 10000,
      summary: 'Damaged item approved under R-04.',
      policyRef: 'REFUND_POLICY.md §5.1',
      traceJson: '[]',
      overridesJson: '[]',
      eligibleItemIdsJson: '["ITM-1001-A"]',
      blockedItemsJson: '[]',
      responseText: 'Approved.',
      extractionJson: null,
      groundingJson: null,
      injectionJson: '{"detected":false}',
      aiMode: 'fake',
      llmCalled: false,
      timingsJson: '{}',
      scenarioId: null,
      ...overrides,
    };
  }

  it('refuses to insert an escalation with money, and stores nothing', () => {
    expect(() =>
      insertRequest(harness.db, newRow({ decision: 'escalated', refundAmountCents: 70000 })),
    ).toThrow(IncoherentDecisionError);

    expect(findRequestById(harness.db, 'REQ-COHERENCE-1')).toBeNull();
  });

  it('stores a coherent pair', () => {
    insertRequest(harness.db, newRow());

    expect(findRequestById(harness.db, 'REQ-COHERENCE-1')?.refundAmountCents).toBe(10000);
  });

  it('leaves the row untouched when an override would make it incoherent', () => {
    // The one override that derives an incoherent pair: approving an order with
    // nothing eligible. The row is denied; if the UPDATE ran before the check, it
    // would be left as `approved` with $0.00 - a badge that promises money the
    // order cannot cover.
    insertRequest(harness.db, newRow({ decision: 'denied', refundAmountCents: 0 }));

    expect(() =>
      applyHumanOverride(harness.db, 'REQ-COHERENCE-1', 'approved', 'alice', 'goodwill', 0),
    ).toThrow(IncoherentDecisionError);

    const row = findRequestById(harness.db, 'REQ-COHERENCE-1');
    expect(row?.decision).toBe('denied');
    expect(row?.refundAmountCents).toBe(0);
    expect(row?.overriddenBy).toBeNull();
  });

  it('zeroes the amount when an override denies an approved request', () => {
    insertRequest(harness.db, newRow());

    applyHumanOverride(harness.db, 'REQ-COHERENCE-1', 'denied', 'alice', 'outside the window', 10000);

    const row = findRequestById(harness.db, 'REQ-COHERENCE-1');
    expect(row?.decision).toBe('denied');
    expect(row?.refundAmountCents).toBe(0);
    // The figure a reviewer needs survives the denial.
    expect(row?.eligibleAmountCents).toBe(10000);
  });

  it('keeps the eligible amount on an override to escalated', () => {
    insertRequest(harness.db, newRow());

    applyHumanOverride(harness.db, 'REQ-COHERENCE-1', 'escalated', 'alice', 'second opinion', 10000);

    const row = findRequestById(harness.db, 'REQ-COHERENCE-1');
    expect(row?.decision).toBe('escalated');
    expect(row?.refundAmountCents).toBe(0);
    expect(row?.eligibleAmountCents).toBe(10000);
  });

  it('lets an admin approve through the override with the eligible amount', () => {
    insertRequest(harness.db, newRow({ decision: 'denied', refundAmountCents: 0 }));

    applyHumanOverride(harness.db, 'REQ-COHERENCE-1', 'approved', 'alice', 'goodwill, item was broken', 10000);

    const row = findRequestById(harness.db, 'REQ-COHERENCE-1');
    expect(row?.decision).toBe('approved');
    expect(row?.refundAmountCents).toBe(10000);
    expect(row?.overriddenBy).toBe('alice');
  });

  it('reads a coherent environment regardless of which writer produced it', () => {
    // Belt and braces: whatever the pipeline or an override wrote, a row read back
    // must satisfy the invariant, or a payout job would act on it.
    insertRequest(harness.db, newRow());

    const row = findRequestById(harness.db, 'REQ-COHERENCE-1');
    expect(row).not.toBeNull();
    expect(() => assertDecisionCoherent(row?.decision as Decision, row?.refundAmountCents ?? -1)).not.toThrow();
    expect(testEnv().ADMIN_API_SECRET.length).toBeGreaterThan(0);
  });
});
