import type { Db } from '../db/connection.js';
import { toProduct, type Product, type ProductRow } from '../shop/catalogue.js';
import { tokenize } from './keywords.js';

/**
 * Literal keyword search over the catalogue for support lookups (ADR 0005).
 *
 * Deliberately no synonym folding: the refund matcher in `keywords.ts` owns
 * its alias map, and sharing it here would let the two matchers disagree
 * through one table. A suggestion is always a row whose own words matched.
 * Prices and stock come from the database, never the query, so a suggestion
 * can never discount a basket.
 */

export interface SearchOptions {
  readonly query: string;
  readonly inStockOnly: boolean;
  readonly maxPriceCents: number | null;
  readonly limit: number;
  /**
   * How terms combine. `all` is the search-box semantic: every word narrows.
   * `any` is the sentence semantic for chat: a full message carries filler
   * around one or two product words, and requiring all of them matches
   * nothing. Defaults to `all` so the catalogue endpoint keeps its shape.
   */
  readonly match?: 'all' | 'any';
}

const MAX_SEARCH_RESULTS = 20;
const MAX_QUERY_TOKENS = 10;

/**
 * Quotes each term so FTS5 syntax in the query is text, never an operator.
 *
 * Terms come from the refund matcher's tokenizer, so filler words never reach
 * the index: without that, a sentence-shaped query fails on its own glue.
 */
function escapeQuery(query: string, match: 'all' | 'any'): string {
  const terms = tokenize(query).slice(0, MAX_QUERY_TOKENS);
  const quoted = terms.map((term) => `"${term}"`);
  return match === 'any' ? quoted.join(' OR ') : quoted.join(' ');
}

/** Searches the FTS index, or filters alone when the query has no terms. */
export function searchProducts(db: Db, opts: SearchOptions): readonly Product[] {
  const cappedLimit = Math.min(opts.limit, MAX_SEARCH_RESULTS);
  const match = opts.match ?? 'all';
  const escaped = escapeQuery(opts.query, match);
  const stockFlag = opts.inStockOnly ? 1 : 0;
  if (escaped === '') {
    // A sentence with no product words in it is not a request for the whole
    // catalogue: answer nothing rather than everything.
    if (match === 'any') {
      return [];
    }
    const rows = db
      .prepare(
        `SELECT * FROM products
          WHERE (? = 0 OR stock > 0) AND (? IS NULL OR price_cents <= ?)
          ORDER BY name LIMIT ?`,
      )
      .all(stockFlag, opts.maxPriceCents, opts.maxPriceCents, cappedLimit) as ProductRow[];
    return rows.map(toProduct);
  }
  const rows = db
    .prepare(
      // MATCH names the FTS table, not its alias: SQLite reads `f MATCH`
      // as a column reference and fails with "no such column: f".
      `SELECT p.* FROM products p
         JOIN products_fts f ON p.rowid = f.rowid
        WHERE products_fts MATCH ?
          AND (? = 0 OR p.stock > 0)
          AND (? IS NULL OR p.price_cents <= ?)
        ORDER BY rank, p.name LIMIT ?`,
    )
    .all(escaped, stockFlag, opts.maxPriceCents, opts.maxPriceCents, cappedLimit) as ProductRow[];
  return rows.map(toProduct);
}
