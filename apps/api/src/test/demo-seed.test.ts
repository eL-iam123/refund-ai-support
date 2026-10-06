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

  it('resumes a killed run instead of stranding a partial demo', async () => {
    // The boot a reviewer interrupts: shoppers and some traces written, the
    // rest missing. The next boot must converge to the full demo, not report
    // the partial counts forever and never touch the missing claims.
    const harness = scenarioHarness({ kind: 'heuristic' });
    seedCatalogue(harness.db);
    await seedDemoData(harness.db, harness, TEST_NOW);

    harness.db.prepare("DELETE FROM refund_requests WHERE id IN ('REQ-DEMO-6', 'REQ-DEMO-9')").run();
    harness.db
      .prepare("DELETE FROM shop_dialogue WHERE customer_message LIKE 'My mug is chipped%'")
      .run();
    const partial = harness.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(partial.n).toBeLessThan(6);

    const resumed = await seedDemoData(harness.db, harness, TEST_NOW);
    expect(resumed.requests + resumed.dialogues).toBe(10);
    const restored = harness.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(restored.n).toBe(6);
    const ids = harness.db
      .prepare('SELECT id, COUNT(*) AS n FROM refund_requests GROUP BY id HAVING n > 1')
      .all();
    expect(ids).toEqual([]);
    harness.db.close();
  });
});
