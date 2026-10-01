import { describe, expect, it } from 'vitest';
import { appHarness } from './helpers.js';
import { seedShop } from '../shop/seed.js';
import { sessionFor } from './shop-helpers.js';
import { TEST_NOW } from './helpers.js';

describe('probe', () => {
  it('f04 approved with inferred order', async () => {
    const h = await appHarness();
    seedShop(h.db, TEST_NOW);
    const items = h.db.prepare(
      `SELECT o.id AS order_id, o.customer_id, p.name FROM orders o
         JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
        WHERE o.customer_id = ?`,
      'CUST-ALMEIDA',
    ).all();
    console.log(`PROBE|items|${JSON.stringify(items)}`);
    const cols = h.db.prepare("SELECT name FROM pragma_table_info('order_items')").all();
    console.log(`PROBE|order_items-cols|${JSON.stringify(cols)}`);
    await h.app.close();
    expect(true).toBe(true);
  });
});
