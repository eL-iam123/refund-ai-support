import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { staffOnly } from '../../auth/guards.js';

/**
 * Live queue analytics, admin-only.
 *
 * Everything here is a count or a sum over rows the staff console already
 * shows, so it adds no new read surface - just a single screen of "how deep is
 * each waiting pile right now". The waiting-money figure is a SUM out of the
 * escalated queue because that is the only place money sits waiting: approved
 * rows are pushed to the verification queue and refunded on settle, so a figure
 * that mixed the two would inflate what actually needs a decision.
 */

export function registerStaffAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/staff/analytics', { preHandler: staffOnly(ctx.env, 'admin', ctx.now) }, () => {
    const now = ctx.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const dayStart = startOfToday.toISOString();

    const openHandoffs = count(
      ctx,
      'SELECT COUNT(*) AS n FROM handoffs WHERE ended_at IS NULL',
    );
    const escalatedAwaiting = count(
      ctx,
      'SELECT COUNT(*) AS n FROM refund_requests WHERE decision = ?',
      'escalated',
    );
    const awaitingReviewCents = number(
      ctx,
      'SELECT COALESCE(SUM(refund_amount_cents), 0) AS s FROM refund_requests WHERE decision = ?',
      'escalated',
    );
    const averageTakeoverMinutes = number(
      ctx,
      'SELECT AVG((julianday(ended_at) - julianday(started_at)) * 1440) AS m FROM handoffs WHERE ended_at IS NOT NULL',
    );

    const decisionRows = ctx.db
      .prepare(
        `SELECT decision AS d, COUNT(*) AS n
           FROM refund_requests
          WHERE created_at >= ?
          GROUP BY decision`,
      )
      .all(dayStart) as { d: string; n: number }[];
    const decisionsToday = {
      approved: decisionRows.find((row) => row.d === 'approved')?.n ?? 0,
      denied: decisionRows.find((row) => row.d === 'denied')?.n ?? 0,
      escalated: decisionRows.find((row) => row.d === 'escalated')?.n ?? 0,
    };

    return {
      analytics: {
        openHandoffs,
        escalatedAwaiting,
        awaitingReviewCents,
        decisionsToday,
        averageTakeoverMinutes,
        since: dayStart,
      },
    };
  });
}

function count(ctx: AppContext, sql: string, ...params: unknown[]): number {
  return number(ctx, sql, ...params);
}

function number(ctx: AppContext, sql: string, ...params: unknown[]): number {
  const row = ctx.db.prepare(sql).get(...params) as { n?: number; s?: number; m?: number } | undefined;
  if (row === undefined) {
    return 0;
  }
  return row.n ?? row.s ?? row.m ?? 0;
}