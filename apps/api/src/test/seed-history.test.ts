import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@refund/shared';
import { scenarioHarness, decided, TEST_NOW } from './helpers.js';
import { seedRequestHistory } from '../db/seedHistory.js';
import { findRequestById } from '../db/requestRepository.js';
import { listRefundsForOrder } from '../db/refundLedger.js';
import { aiModeLabel } from '../http/context.js';

/**
 * The seeded console history is produced, not written.
 *
 * `seedRequestHistory` runs each canonical scenario through the same
 * `processRefundRequest` a storefront message goes through, so a demo row is
 * the pipeline's own outcome - trace, grounding, response text and all - and
 * not a hand-built stand-in. These tests pin that: a seed run must be
 * byte-identical, row for row, to a fresh live run of the same input, apart
 * from the fixed request id, the scenario tag and the staggered timestamp.
 */
describe('seeded request history', () => {
  it('reproduces, run for run, the decision a live request would get', async () => {
    const s01 = SCENARIOS.find((candidate) => candidate.id === 'S-01');
    expect(s01).toBeDefined();
    if (s01 === undefined || s01.orderId === null) throw new Error('S-01 missing order');

    // A live run of the same input, on its own database so its reservation does
    // not collide with the one the seeder makes.
    const liveHarness = scenarioHarness();
    const live = decided(
      await liveHarness.run({ customerId: s01.customer.key, orderId: s01.orderId, message: s01.message }),
    );

    const harness = scenarioHarness();
    const outcome = await seedRequestHistory(harness.db, TEST_NOW, harness);
    expect(outcome).toEqual({ created: 5, asked: 0 });

    const row = findRequestById(harness.db, 'seed-s-01');
    expect(row).not.toBeNull();
    if (row === null) throw new Error('seed-s-01 missing');

    // The row is the real pipeline output for this input, not a fixture row.
    expect(row.responseText).toBe(live.responseText);
    expect(row.summary).toBe(live.decision.summary);
    expect(JSON.parse(row.traceJson)).toEqual(live.decision.trace);
    expect(JSON.parse(row.groundingJson ?? 'null')).toEqual(live.grounding);
    expect(JSON.parse(row.extractionJson ?? 'null')).toEqual(live.extraction);
    expect(row.decision).toBe(live.decision.decision);
    expect(row.refundAmountCents).toBe(live.decision.refundAmountCents);
    expect(row.aiMode).toBe(aiModeLabel(harness));

    // The provenance tag survives the real run.
    expect(row.scenarioId).toBe('S-01');
    // And it carries an engine response, not the old canned filler.
    expect(row.responseText).not.toContain('Seeded example');
  });

  it('is idempotent: a second call on the same database creates nothing', async () => {
    const harness = scenarioHarness();
    await seedRequestHistory(harness.db, TEST_NOW, harness);

    const again = await seedRequestHistory(harness.db, TEST_NOW, harness);
    expect(again).toEqual({ created: 0, asked: 0 });
  });

  it('settles the settled scenario through the ledger and leaves the rest pending', async () => {
    const harness = scenarioHarness();
    await seedRequestHistory(harness.db, TEST_NOW, harness);

    const s01 = SCENARIOS.find((candidate) => candidate.id === 'S-01');
    const s02 = SCENARIOS.find((candidate) => candidate.id === 'S-02');
    expect(s01?.orderId).not.toBeNull();
    expect(s02?.orderId).not.toBeNull();

    expect(listRefundsForOrder(harness.db, s01?.orderId ?? '').map((refund) => refund.status)).toEqual([
      'settled',
    ]);
    expect(listRefundsForOrder(harness.db, s02?.orderId ?? '').map((refund) => refund.status)).toEqual([
      'pending_verification',
    ]);
  });
});