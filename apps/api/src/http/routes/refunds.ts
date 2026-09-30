import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { auditEventKinds, listAuditEventsPage, verifyAuditChain, type ChainVerdict } from '../../db/auditChain.js';
import { insertAuditEvent } from '../../db/requestRepository.js';
import { staffOnly } from '../../auth/guards.js';
import type { Principal } from '../../auth/tokens.js';
import { NotFoundError, badRequest, conflict } from '../errors.js';
import {
  RefundLedgerError,
  findRefundById,
  listRefundsByStatus,
  releaseRefund,
  settleRefund,
  REFUND_STATUSES,
  type RefundRecord,
} from '../../db/refundLedger.js';
import { findRequestById } from '../../db/requestRepository.js';
import { recordCustomerUpdate } from '../../db/customerUpdates.js';
import { followUpFor } from '../../response/followUp.js';
import { toRefundDto } from '../serialize.js';
import { ListAuditQuerySchema, type AuditChainDto, type RefundDto } from '@refund/shared';

/**
 * Flattens the chain verdict for the wire.
 *
 * The domain type is a discriminated union because that is the honest shape
 * internally - a failure has a broken row and a reason, a success does not. The
 * DTO keeps the same information but always present, so a client can render
 * "checked N rows" without first checking which variant it got.
 */
function toChainDto(verdict: ChainVerdict): AuditChainDto {
  return verdict.ok
    ? { ok: true, checked: verdict.checked, headHash: verdict.headHash, brokenAtId: null, reason: null }
    : { ok: false, checked: verdict.checked, headHash: null, brokenAtId: verdict.brokenAtId, reason: verdict.reason };
}

const RefundIdParams = z.object({ id: z.string().trim().min(1).max(120) });

const ListRefundsQuery = z.object({
  status: z.enum(REFUND_STATUSES).default('pending_verification'),
});

const ReleaseBody = z.object({
  reason: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'releasing a reservation has to say why').max(2000)),
});

function requirePrincipal(principal: Principal | undefined): Principal {
  if (principal === undefined) {
    throw new Error('refund route reached without an authenticated principal');
  }
  return principal;
}

function parseOr<T>(result: { success: true; data: T } | { success: false; error: z.ZodError }, what: string): T {
  if (result.success) {
    return result.data;
  }
  throw badRequest(`invalid ${what}`, result.error.issues.map((issue) => issue.message));
}

/**
 * A ledger failure is a 409, not a 500.
 *
 * "Already settled" and "nothing left to pay" are the outcomes a reviewer
 * double-clicking is most likely to hit, and both are ordinary answers rather
 * than faults. Surfacing them as server errors would teach staff that this
 * screen is broken instead of telling them what happened.
 */
function toConflict(error: unknown): Error {
  if (error instanceof RefundLedgerError) {
    return conflict('refund_conflict', error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function existingOr404(ctx: AppContext, id: string): RefundRecord {
  const refund = findRefundById(ctx.db, id);
  if (refund === null) {
    throw new NotFoundError('refund', id);
  }
  return refund;
}

function audit(ctx: AppContext, requestId: string, at: string, kind: string, detail: string): void {
  insertAuditEvent(ctx.db, requestId, at, kind, detail);
}

/**
 * Tells the customer what just happened to their money.
 *
 * Written in the same transaction as the ledger entry it describes, for the same
 * reason the ledger entry is: a payout that moved with no message to the customer
 * is a support ticket waiting to happen, and one that sent a message describing
 * a payout that did not happen is worse.
 *
 * The amount comes from the refund record, never from the route, so the message
 * cannot claim a figure the ledger did not.
 */
function notifyCustomer(
  ctx: AppContext,
  requestId: string,
  kind: 'refund_sent' | 'refund_withdrawn',
  amountCents: number,
): void {
  const request = findRequestById(ctx.db, requestId);
  if (request === null) {
    return;
  }
  recordCustomerUpdate(ctx.db, {
    customerId: request.customerId,
    orderId: request.orderId,
    requestId,
    kind,
    body: followUpFor({
      kind,
      orderId: request.orderId,
      previousDecision: request.decision,
      decision: request.decision,
      amountCents: request.refundAmountCents,
      paidCents: amountCents,
    }),
    now: ctx.now(),
  });
}

/**
 * The verification queue and the identity behind it.
 *
 * Who the console is acting as comes from the same token the server attributes
 * the override to, so the console asks rather than asks-and-also-claims: a
 * displayed name the client chose would be the exact bug removed from the API.
 */
function registerRefundReadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const staff = staffOnly(ctx.env, 'agent', ctx.now);

  app.get('/api/whoami', { preHandler: staff }, (request: FastifyRequest) => {
    const principal = requirePrincipal(request.principal);
    return { subject: principal.subject, role: principal.role, expiresAt: principal.expiresAt.toISOString() };
  });

  /**
   * Verifies the audit chain on demand.
   *
   * Exists because tamper evidence nobody can check is decoration. An operator
   * needs to be able to ask the question and get a verdict naming the row that
   * failed, without a debugger and a copy of the source.
   */
  app.get('/api/admin/audit/verify', { preHandler: staffOnly(ctx.env, 'admin', ctx.now) }, () => {
    const verdict = verifyAuditChain(ctx.db);
    if (!verdict.ok) {
      ctx.log.error({ brokenAtId: verdict.brokenAtId, reason: verdict.reason }, 'audit.chain.broken');
    }
    return { audit: verdict };
  });

  /**
   * The whole trail, for the admin log screen.
   *
   * Lives beside `/api/admin/audit/verify` on purpose: both are answers to
   * "what happened, and can I trust that log", and splitting them across route
   * files made it easy to update one and forget the other.
   *
   * The verdict travels with the events rather than being a second request,
   * because a log page that renders rows from one moment and a verdict from
   * another can show "intact" above rows that were written after the check.
   */
  app.get('/api/admin/audit', { preHandler: staffOnly(ctx.env, 'admin', ctx.now) }, (request: FastifyRequest) => {
    const query = parseOr(ListAuditQuerySchema.safeParse(request.query), 'audit filter');
    const verdict = verifyAuditChain(ctx.db);
    if (!verdict.ok) {
      ctx.log.error({ brokenAtId: verdict.brokenAtId, reason: verdict.reason }, 'audit.chain.broken');
    }
    const page = listAuditEventsPage(ctx.db, {
      kind: query.kind ?? null,
      requestId: query.requestId ?? null,
      since: query.since ?? null,
      q: query.q ?? null,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      events: page.events,
      total: page.total,
      kinds: auditEventKinds(ctx.db),
      audit: toChainDto(verdict),
    };
  });

  app.get('/api/refunds', { preHandler: staff }, (request: FastifyRequest) => {
    const query = parseOr(ListRefundsQuery.safeParse(request.query), 'refund filter');
    const refunds: RefundDto[] = listRefundsByStatus(ctx.db, query.status).map(toRefundDto);
    return { refunds };
  });
}

/**
 * The step that actually moves money, and the reason it is admin-only.
 *
 * This is deliberately not an `agent` action. Approving a refund is a policy
 * decision the pipeline can reach on its own; issuing one is an act of
 * disbursement against the company's funds, so it sits a role above.
 */
function settle(ctx: AppContext, id: string, agent: string): { refund: RefundDto; auditEvent: { kind: string; detail: string; at: string } } {
  const params = parseOr(RefundIdParams.safeParse({ id }), 'refund id');
  existingOr404(ctx, params.id);

  const now = ctx.now();
  let settled: RefundRecord;
  try {
    settled = settleRefund(ctx.db, params.id, agent, now);
  } catch (error: unknown) {
    throw toConflict(error);
  }

  // The ledger write and the audit record share a transaction, because a payment
  // that settled with no trace of who authorised it is unreviewable.
  const at = now.toISOString();
  const detail = `${settled.amountCents} cents settled for request ${settled.requestId}`;
  ctx.db.transaction(() => {
    audit(ctx, settled.requestId, at, 'refund_settled', detail);
    notifyCustomer(ctx, settled.requestId, 'refund_sent', settled.amountCents);
  })();

  ctx.log.info({ refundId: settled.id, agent, amountCents: settled.amountCents }, 'refund.settled');
  return { refund: toRefundDto(settled), auditEvent: { kind: 'refund_settled', detail, at } };
}

/**
 * Releases a reservation without paying it.
 *
 * Separate from settling because these are opposite acts with opposite
 * justifications: collapsing them into one "cancel" button would make the
 * unreviewed path as easy to take as the reviewed one.
 */
function release(ctx: AppContext, id: string, body: unknown): { refund: RefundDto } {
  const params = parseOr(RefundIdParams.safeParse({ id }), 'refund id');
  const reason = parseOr(ReleaseBody.safeParse(body ?? {}), 'release');
  existingOr404(ctx, params.id);

  const now = ctx.now();
  let released: RefundRecord;
  try {
    released = releaseRefund(ctx.db, params.id, reason.reason, now);
  } catch (error: unknown) {
    throw toConflict(error);
  }

  ctx.db.transaction(() => {
    audit(ctx, released.requestId, now.toISOString(), 'refund_released', `${released.amountCents} cents released: ${reason.reason}`);
    notifyCustomer(ctx, released.requestId, 'refund_withdrawn', 0);
  })();
  ctx.log.info({ refundId: released.id, amountCents: released.amountCents }, 'refund.released');
  return { refund: toRefundDto(released) };
}

function registerRefundWriteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = staffOnly(ctx.env, 'admin', ctx.now);

  app.post<{ Params: unknown }>('/api/refunds/:id/settle', { preHandler: admin }, (request) => {
    const { id } = request.params as { id: string };
    return settle(ctx, id, requirePrincipal(request.principal).subject);
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/refunds/:id/release', { preHandler: admin }, (request) => {
    const { id } = request.params as { id: string };
    return release(ctx, id, request.body);
  });
}

export function registerRefundRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerRefundReadRoutes(app, ctx);
  registerRefundWriteRoutes(app, ctx);
}
