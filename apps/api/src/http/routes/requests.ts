import type { FastifyInstance } from 'fastify';
import {
  ListRequestsQuerySchema,
  OverrideDecisionSchema,
  type OverrideDecision,
} from '@refund/shared';
import type { AppContext } from '../context.js';
import type { PersistedRequest } from '../../db/records.js';
import {
  applyHumanOverride,
  findRequestById,
  insertAuditEvent,
  listAuditEvents,
  listRequests,
} from '../../db/requestRepository.js';
import { listLlmCalls } from '../../db/statsRepository.js';
import { toRequestDto, toSummaryDto } from '../serialize.js';
import { NotFoundError, OverrideRefusedError, badRequest } from '../errors.js';
import { staffOnly } from '../../auth/guards.js';
import type { Principal } from '../../auth/tokens.js';
import { checkOverride, type OverrideRefusal } from '../../policy/overrideGuard.js';
import { findOrder } from '../../db/orderRepository.js';
import { RuleEvaluationSchema } from '@refund/shared';
import { FULLY_REFUNDED } from '../../policy/constants.js';
import { authoriseRefund, releaseRefundsForRequest } from '../../db/refundLedger.js';
import { recordCustomerUpdate } from '../../db/customerUpdates.js';
import { followUpFor } from '../../response/followUp.js';
import { formatCents } from '../../lib/money.js';

/**
 * GET /api/requests, GET /api/requests/:id, POST /api/requests/:id/override
 *
 * The admin surface's read and write paths. A human override is recorded as
 * a mutation of the decision *after* the fact: the original resolver output
 * stays in the trace, so the drawer shows both what the policy said and what
 * the agent decided.
 */
export function registerRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Reading decisions and changing them are different permissions. An agent
  // investigates; only an admin rewrites an outcome. Splitting them here means a
  // compromised agent account cannot approve money.
  const staff = (role: 'agent' | 'admin') => ({
    preHandler: staffOnly(ctx.env.ADMIN_API_SECRET, role, ctx.now),
  });

  app.get('/api/requests', staff('agent'), (request) => {
    const query = ListRequestsQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw badRequest('invalid query', query.error.issues.map((issue) => issue.message));
    }

    const rows = listRequests(ctx.db, {
      limit: query.data.limit,
      decision: query.data.decision,
      customerId: query.data.customerId,
      search: query.data.q,
    });
    return { requests: rows.map(toSummaryDto) };
  });

  app.get('/api/requests/:id', staff('agent'), (request) => {
    const params = request.params as { id: string };
    const row = findRequestById(ctx.db, params.id);
    if (row === null) {
      throw new NotFoundError('request', params.id);
    }

    return {
      request: toRequestDto(row),
      audit: listAuditEvents(ctx.db, params.id),
      llmCalls: listLlmCalls(ctx.db, params.id),
    };
  });

  app.post('/api/requests/:id/override', staff('admin'), (request) => {
    const params = request.params as { id: string };
    const body = OverrideDecisionSchema.safeParse(request.body);
    if (!body.success) {
      throw badRequest(
        'invalid override',
        body.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }

    // Taken from the verified token, not the body. Every `admin` on earth could
    // otherwise write another agent's name into the audit trail.
    const agentId = requirePrincipal(request.principal).subject;

    const existing = findRequestById(ctx.db, params.id);
    if (existing === null) {
      throw new NotFoundError('request', params.id);
    }

    refuseIfNotAllowed(ctx, existing, body.data);

    const applied = applyOverride(ctx, params.id, body.data, existing, agentId);
    const updated = findRequestById(ctx.db, params.id);
    if (updated === null) {
      throw new NotFoundError('request', params.id);
    }

    return { request: toRequestDto(updated) , auditEvent: applied };
  });
}

/**
 * Whether the policy permits this particular reversal.
 *
 * The guard lives here rather than in the repository so that refusing is a
 * decision with a reason attached, not a constraint buried in a write. It reads
 * the order's real refund state rather than the stored decision, because the
 * question "has this money already gone out?" is a fact about the order and not
 * about what the resolver concluded last time.
 */
/**
 * The authenticated caller. Behind `staffOnly` this cannot be missing, so an
 * absent principal is a wiring fault rather than an anonymous request, and it is
 * reported as such instead of being coerced into a default identity.
 */
function requirePrincipal(principal: Principal | undefined): Principal {
  if (principal === undefined) {
    throw new Error('override route reached without an authenticated principal');
  }
  return principal;
}

function refuseIfNotAllowed(
  ctx: AppContext,
  existing: PersistedRequest,
  override: OverrideDecision,
): void {
  const order = existing.orderId === null ? null : findOrder(ctx.db, existing.customerId, existing.orderId, ctx.now());
  const parsed = RuleEvaluationSchema.array().safeParse(JSON.parse(existing.traceJson));

  const refusal: OverrideRefusal | null = checkOverride({
    current: existing.decision,
    next: override.decision,
    trace: parsed.success ? parsed.data : [],
    alreadyFullyRefunded:
      order !== null && order.paymentState === FULLY_REFUNDED && order.refundedCents >= order.totalCents,
    acknowledged: override.acknowledgeHardBlock === true,
  });

  if (refusal === null) {
    return;
  }
  throw new OverrideRefusedError(refusal.message, refusal.ruleIds);
}

/**
 * Records the agent's decision and the fact that they made it.
 *
 * The amount is never taken from the request body. It is re-derived from the
 * order-derived eligible amount, so a human can change the decision but cannot
 * invent a figure: there is no field to set, and `assertDecisionCoherent`
 * refuses a denial that would carry money or an approval that would carry none.
 */
function applyOverride(
  ctx: AppContext,
  requestId: string,
  override: OverrideDecision,
  previous: PersistedRequest,
  agentId: string,
): { kind: string; detail: string; at: string } {
  const at = ctx.now().toISOString();
  const previousDecision = previous.decision;
  const acknowledged = override.acknowledgeHardBlock === true ? ' [hard block acknowledged]' : '';
  const detail = `${previousDecision} -> ${override.decision} by ${agentId}${acknowledged}: ${override.note}`;

  const apply = ctx.db.transaction(() => {
    applyHumanOverride(
      ctx.db,
      requestId,
      override.decision,
      agentId,
      override.note,
      previous.eligibleAmountCents,
    );
    // An override that takes the money away must also hand the money back. The
    // approval reserved a balance against the order (R-06b), and a reservation
    // that outlives the decision that created it would quietly shrink what the
    // customer can claim for the rest of the order's life.
    if (override.decision === 'approved' && previousDecision !== 'approved' && previous.orderId !== null) {
      // A person approving a claim the policy refused creates the same
      // reservation the pipeline would have. Without this the decision says
      // money is owed and nothing ever pays it: the row is never in the queue,
      // so no reviewer is ever asked. The amount is the order-derived one, the
      // same figure the decision itself carries - there is no field to set.
      const authorised = authoriseRefund(ctx.db, {
        requestId,
        orderId: previous.orderId,
        customerId: previous.customerId,
        amountCents: previous.eligibleAmountCents,
        now: ctx.now(),
      });
      insertAuditEvent(
        ctx.db,
        requestId,
        at,
        'refund_authorised',
        `${formatCents(authorised.amountCents)} pending human verification`,
      );
    }

    if (previousDecision === 'approved' && override.decision !== 'approved') {
      for (const released of releaseRefundsForRequest(
        ctx.db,
        requestId,
        `override ${previousDecision} -> ${override.decision}: ${override.note}`,
        ctx.now(),
      )) {
        insertAuditEvent(
          ctx.db,
          requestId,
          at,
          'refund_released',
          `${released.amountCents} cents released: ${override.note}`,
        );
      }
    }
    insertAuditEvent(ctx.db, requestId, at, 'human_override', detail);

    notifyCustomer(ctx, requestId, previousDecision);
  });

  apply();
  return { kind: 'human_override', detail, at };
}

/**
 * Tells the customer what the person just decided.
 *
 * In the same transaction as the decision, and that placement is the point. An
 * override that succeeded and then failed to write its follow-up would leave a
 * person having reviewed a claim and the customer never learning the outcome -
 * the worst state to discover a week later, because nothing in the system looks
 * broken. Either both are durable or neither happened.
 *
 * Reads the request back rather than trusting the arguments, so the message
 * describes the decision that was actually stored and not the one that was
 * asked for.
 */
function notifyCustomer(ctx: AppContext, requestId: string, previousDecision: string): void {
  const updated = findRequestById(ctx.db, requestId);
  if (updated === null) {
    return;
  }
  recordCustomerUpdate(ctx.db, {
    customerId: updated.customerId,
    orderId: updated.orderId,
    requestId,
    kind: 'human_decision',
    body: followUpFor({
      kind: 'human_decision',
      orderId: updated.orderId,
      previousDecision,
      decision: updated.decision,
      amountCents: updated.refundAmountCents,
      paidCents: 0,
    }),
    now: ctx.now(),
  });
}
