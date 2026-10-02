import type { FastifyInstance } from 'fastify';
import { DECISIONS, type Decision } from '@refund/shared';
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
    // Every decision value the system can produce, not a hand-picked three. The
    // discretion layer can resolve a request as a partial refund, an exchange or
    // store credit, and a tally that counted only the base policy's outcomes
    // would report a day of twenty exchanges as a day where nothing was decided
    // - which is the exact reading the strip exists to prevent.
    const decisionsToday = tallyDecisions(decisionRows);

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

/**
 * Requests per decision, oldest first, keyed by the enum.
 *
 * Initialised from `DECISIONS` rather than written out, so a new outcome is
 * counted the day it is added instead of being silently dropped by a literal
 * that was last edited when there were three outcomes. An unrecognised value in
 * the column is ignored rather than invented into the tally.
 */
function tallyDecisions(rows: readonly { d: string; n: number }[]): Record<Decision, number> {
  const tally: Record<Decision, number> = {
    approved: 0,
    denied: 0,
    escalated: 0,
    partial_refund: 0,
    exchange: 0,
    store_credit: 0,
  };
  for (const decision of DECISIONS) {
    tally[decision] = rows.find((row) => row.d === decision)?.n ?? 0;
  }
  return tally;
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