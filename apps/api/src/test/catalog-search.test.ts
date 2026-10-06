import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { seedShop } from '../shop/seed.js';
import { insertProduct } from '../shop/catalogue.js';

/**
 * Catalogue search (ADR 0005, slice 1).
 *
 * Read-only by construction: every assertion is about which rows come back,
 * never about money. The properties that matter are that a bare GET keeps its
 * old shape, that query syntax is text rather than an operator, that filters
 * narrow, and that the FTS index tracks writes through the triggers.
 */

interface ProductBody {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly stock: number;
}

describe('catalogue search', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  async function products(url: string): Promise<{ status: number; items: readonly ProductBody[] }> {
    const response = await harness.app.inject({ method: 'GET', url });
    const body = response.json<{ products: readonly ProductBody[] }>();
    return { status: response.statusCode, items: body.products };
  }

  it('returns the full catalogue in seed order when no filter is given', async () => {
    const { status, items } = await products('/api/shop/products');
    expect(status).toBe(200);
    expect(items).toHaveLength(14);
    expect(items[0]?.id).toBe('PRD-LAMP-01');
  });

  it('finds a product by name and ranks the name match first', async () => {
    // "mug" is in the mug's name and only mentioned in the tote's description,
    // so the mug must come first when both match.
    const { status, items } = await products('/api/shop/products?q=mug');
    expect(status).toBe(200);
    const ids = items.map((item) => item.id);
    expect(ids[0]).toBe('PRD-MUG-01');
    expect(ids).toContain('PRD-TOTE-01');
  });

  it('treats FTS syntax as text instead of failing', async () => {
    for (const raw of ['*" OR (', '"', '(', 'kettle (copper)']) {
      const { status } = await products(`/api/shop/products?q=${encodeURIComponent(raw)}`);
      expect(status).toBe(200);
    }
  });

  it('narrows by price and stock', async () => {
    const cheap = await products('/api/shop/products?maxPriceCents=1000');
    expect(cheap.status).toBe(200);
    expect(cheap.items.map((item) => item.id)).toEqual(['PRD-PIN-01']);

    harness.db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run('PRD-MUG-01');
    const withoutFilter = await products('/api/shop/products?q=mug');
    expect(withoutFilter.items.map((item) => item.id)).toContain('PRD-MUG-01');
    const inStock = await products('/api/shop/products?q=mug&inStock=true');
    expect(inStock.status).toBe(200);
    expect(inStock.items.map((item) => item.id)).not.toContain('PRD-MUG-01');
  });

  it('orders the filter-only path by name and honours limit', async () => {
    const { status, items } = await products('/api/shop/products?inStock=false&limit=50');
    expect(status).toBe(200);
    const names = items.map((item) => item.name);
    expect(names).toEqual([...names].sort());

    const one = await products('/api/shop/products?inStock=false&limit=1');
    expect(one.items).toHaveLength(1);
  });

  it('rejects out-of-range filters', async () => {
    for (const url of [
      '/api/shop/products?limit=0',
      '/api/shop/products?limit=51',
      '/api/shop/products?limit=abc',
      '/api/shop/products?maxPriceCents=-5',
    ]) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
    }
  });

  it('caps results at the retrieval bound and tracks inserts', async () => {
    const EXTRA_PRODUCTS = 25;
    for (let i = 0; i < EXTRA_PRODUCTS; i += 1) {
      insertProduct(harness.db, {
        id: `PRD-BULK-${i}`,
        name: `Bulk Widget ${i}`,
        blurb: 'a bulk widget for bound testing',
        description: 'a bulk widget for bound testing',
        priceCents: 100,
        finalSale: false,
        digital: false,
        isSubscription: false,
        stock: 5,
        testsPolicy: null,
        imageHue: 0,
      });
    }
    // The insert trigger kept the index: all 25 new rows match immediately.
    const { status, items } = await products('/api/shop/products?q=widget&limit=50');
    expect(status).toBe(200);
    expect(items).toHaveLength(20);
  });

  it('tracks updates through the FTS triggers', async () => {
    harness.db
      .prepare('UPDATE products SET name = ?, blurb = ?, description = ? WHERE id = ?')
      .run('Zedwark Unique Gadget', 'unlike anything else', 'a gadget with no peers', 'PRD-PIN-01');
    const { status, items } = await products('/api/shop/products?q=zedwark');
    expect(status).toBe(200);
    expect(items.map((item) => item.id)).toEqual(['PRD-PIN-01']);
  });

  it('builds the FTS index on migrate', () => {
    const row = harness.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'products_fts'")
      .get() as { present: number } | undefined;
    expect(row?.present).toBe(1);
  });
});
