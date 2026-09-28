import type { Statement } from 'better-sqlite3';
import type { Db } from './connection.js';
import type { CustomerTier } from './records.js';
import type { CustomerRecord } from './records.js';

/**
 * better-sqlite3's `get`/`all` are typed as `unknown` by design: the driver
 * cannot know the shape of a result row. Every row read in the codebase goes
 * through this one helper so the cast lives in a single audited place instead
 * of being sprinkled through the repositories.
 */
export function queryOne<T>(statement: Statement, ...params: unknown[]): T | null {
  const row: unknown = statement.get(...params);
  return row === undefined ? null : (row as T);
}

export function queryAll<T>(statement: Statement, ...params: unknown[]): T[] {
  const rows: unknown = statement.all(...params);
  return rows as T[];
}

interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly tier: string;
  readonly account_created_at: string;
  readonly prior_refund_count: number;
  readonly refund_requests_last_30d: number;
}

function toRecord(row: CustomerRow, now: Date): CustomerRecord {
  const accountCreatedAt = new Date(row.account_created_at);
  const accountAgeDays = Math.max(
    0,
    Math.floor((now.getTime() - accountCreatedAt.getTime()) / 86_400_000),
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    tier: row.tier as CustomerTier,
    accountCreatedAt,
    accountAgeDays,
    priorRefundCount: row.prior_refund_count,
    refundRequestsLast30Days: row.refund_requests_last_30d,
  };
}

export function findCustomer(db: Db, id: string, now: Date): CustomerRecord | null {
  const row = queryOne<CustomerRow>(
    db.prepare('SELECT * FROM customers WHERE id = ?'),
    id,
  );
  return row === null ? null : toRecord(row, now);
}

export function listCustomers(db: Db, now: Date): CustomerRecord[] {
  return queryAll<CustomerRow>(db.prepare('SELECT * FROM customers ORDER BY name')).map((row) =>
    toRecord(row, now),
  );
}
