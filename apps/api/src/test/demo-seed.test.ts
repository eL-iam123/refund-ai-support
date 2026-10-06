import { describe, expect, it } from 'vitest';
import { seedDemoData } from '../db/demoSeed.js';
import { seedCatalogue } from '../shop/seed.js';
import { scenarioHarness } from './helpers.js';
import { TEST_NOW } from './helpers.js';

/**
 * The demo seed counts what it stores.
 *
 * A seed report is a claim about the database, and a report of fifteen
 * customers with zero requests is either a lie or a crash nobody noticed.
 * So this pins both halves: the counts name persisted rows, and a second
 * run resumes from the stored completions instead of redoing or skipping
 * work.
 */
describe('demo seeding', () => {
  it('persists the claims it counts, and reseeds from completion', async () => {
    const harness = scenarioHarness({ kind: 'heuristic' });
    // Stock only, the way boot does it: the demo seed brings its own shoppers.
    seedCatalogue(harness.db);

    const seeded = await seedDemoData(harness.db, harness, TEST_NOW);
    expect(seeded.customers).toBeGreaterThan(0);
    expect(seeded.orders).toBeGreaterThan(0);
    // Every fixture leaves one trace: a decided request or a recorded
    // clarification. Ten fixtures, ten traces, nothing silently dropped.
    expect(seeded.requests + seeded.dialogues).toBe(10);

    const stored = harness.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(stored.n).toBe(seeded.requests);
    const dialogues = harness.db.prepare('SELECT COUNT(*) AS n FROM shop_dialogue').get() as { n: number };
    expect(dialogues.n).toBe(seeded.dialogues);

    const again = await seedDemoData(harness.db, harness, TEST_NOW);
    expect(again.requests).toBe(seeded.requests);
    expect(again.dialogues).toBe(seeded.dialogues);
    const restated = harness.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(restated.n).toBe(seeded.requests);
    const redialogued = harness.db.prepare('SELECT COUNT(*) AS n FROM shop_dialogue').get() as { n: number };
    expect(redialogued.n).toBe(seeded.dialogues);
    harness.db.close();
  });
});
