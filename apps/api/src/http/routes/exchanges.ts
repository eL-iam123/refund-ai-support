import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict, NotFoundError } from '../errors.js';
import { staffOnly } from '../../auth/guards.js';
import { insertAuditEvent } from '../../db/requestRepository.js';
import { findOrder } from '../../db/orderRepository.js';
import {
  ExchangeLedgerError,
  EXCHANGE_STATUSES,
  canDenyExchange,
  createExchange,
  denyExchange,
  exchangeTransitions,
  findExchangeById,
  findExchangeByRequestId,
  generateExchangeLabel,
  listExchangeItems,
  listExchanges,
  markExchangeReceived,
  markExchangeReplaced,
  markExchangeShipped,
  type ExchangeRecord,
  type ExchangeStatus,
} from '../../db/exchanges.js';

/**
 * Exchanges: the staff action surface for building a replacement.
 *
 * A customer can talk to the assistant about wanting one, but nobody on the
 * customer side can assert that a label was bought or a box left - those are
 * physical facts, and each one is staff-only, the same trust the return ledger
 * places. Where this module adds on top of the return track is the point of
 * closure: the exchange is not done when the old goods arrive, it is done when
 * the replacement goes out.
 *
 * The console verbs live under `/api/staff` beside take-over / message / close,
 * because initiating an exchange is a case action taken by the agent holding it.
 * The inbound-leg transitions reuse the shape of the return endpoints, so a
 * warehouse operator who runs returns runs these without a new vocabulary.
 */

const StaffOrderQuery = z.object({
  customerId: z.string().trim().min(1).max(120),
  orderId: z.string().trim().min(1).max(120),
});

const ExchangeIdParams = z.object({ id: z.string().trim().min(1).max(120) });

const RequestIdParams = z.object({ requestId: z.string().trim().min(1).max(120) });

const ListExchangesQuery = z.object({
  status: z.enum(EXCHANGE_STATUSES).optional(),
  customerId: z.string().trim().min(1).max(120).optional(),
  orderId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateExchangeBody = z.object({
  /**
   * The refund request this exchange answers, if the case on the console has
   * one. When present it is the idempotency key, exactly as with a return.
   */
  requestId: z.string().trim().min(1).max(120).optional(),
  orderId: z.string().trim().min(1).max(120),
  /** The case the agent is holding. The ledger refuses an order not owned by it. */
  customerId: z.string().trim().min(1).max(120),
  items: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(50),
  reason: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'say what is wrong with the item').max(2000)),
  replacementNote: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'say what will be sent instead').max(2000))
    .optional(),
});

const LabelBody = z.object({
  carrier: z.enum(['usps', 'ups', 'fedex']).default('usps'),
  labelUrl: z.string().trim().url().max(500),
});

const ShipBody = z.object({
  carrier: z.enum(['usps', 'ups', 'fedex']),
  trackingNumber: z.string().trim().min(4).max(120),
});

const ReceiveBody = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(0).max(100),
        condition: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(50),
});

const DenyBody = z.object({
  reason: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'a denial needs a reason the customer could be shown').max(2000)),
});

function parseOr<T>(result: { success: true; data: T } | { success: false; error: z.ZodError }, what: string): T {
  if (result.success) {
    return result.data;
  }
  throw badRequest(`invalid ${what}`, result.error.issues.map((issue) => issue.message));
}

/**
 * An illegal state change is a 409, not a 500, for the same reasons a return
 * answers that way: double-clicking a warehouse operator and a duplicated webhook
 * both look exactly like this.
 */
function toConflict(error: unknown): Error {
  if (error instanceof ExchangeLedgerError) {
    return conflict('exchange_conflict', error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function existingOr404(ctx: AppContext, id: string): ExchangeRecord {
  const found = findExchangeById(ctx.db, id);
  if (found === null) {
    throw new NotFoundError('exchange', id);
  }
  return found;
}

function attempt(ctx: AppContext, id: string, move: () => ExchangeRecord): ExchangeRecord {
  existingOr404(ctx, id);
  try {
    return move();
  } catch (error: unknown) {
    throw toConflict(error);
  }
}

/**
 * Records who moved an exchange and why.
 *
 * Keyed like a return's audit: by the request it answers when it has one, and
 * under `exchange:<id>` when it does not - the `:` character is not in the id
 * set, so the key cannot collide with a request id.
 */
function audit(ctx: AppContext, record: ExchangeRecord, kind: string, detail: string, at: Date): void {
  insertAuditEvent(ctx.db, record.requestId ?? `exchange:${record.id}`, at.toISOString(), kind, detail);
}

export function registerExchangeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agent = staffOnly(ctx.env, 'agent', ctx.now);
  registerExchangeReadRoutes(app, ctx, agent);
  registerExchangeBuildRoutes(app, ctx, agent);
}

/**
 * The order the agent is acting on, with its lines.
 *
 * The console's case file carries an order id but not the item names and
 * quantities a picker needs, and there is no public order read that names a
 * customer id - the storefront resolves that from a cookie. This endpoint is
 * the staff matching half: it takes both ids and the ownership check answers
 * 404 when they disagree, so it cannot be used to enumerate a stranger's order
 * any more than `findOrder` could.
 */
function registerExchangeReadRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  app.get('/api/staff/exchanges', { preHandler: agent }, (request: FastifyRequest) => {
    const query = parseOr(ListExchangesQuery.safeParse(request.query), 'exchange filter');
    const filters: { status?: ExchangeStatus; customerId?: string; orderId?: string; limit: number } = {
      limit: query.limit,
    };
    if (query.status !== undefined) {
      filters.status = query.status;
    }
    if (query.customerId !== undefined) {
      filters.customerId = query.customerId;
    }
    if (query.orderId !== undefined) {
      filters.orderId = query.orderId;
    }
    return { exchanges: listExchanges(ctx.db, filters) };
  });

  app.get<{ Params: unknown }>('/api/staff/exchanges/:id', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const record = existingOr404(ctx, id);
    return {
      exchange: record,
      items: listExchangeItems(ctx.db, id),
      nextStates: exchangeTransitions(record.status),
      canDeny: canDenyExchange(record.status),
    };
  });

  app.get<{ Params: unknown }>('/api/staff/exchanges/by-request/:requestId', { preHandler: agent }, (request) => {
    const { requestId } = parseOr(RequestIdParams.safeParse(request.params), 'request id');
    const record = findExchangeByRequestId(ctx.db, requestId);
    if (record === null) {
      throw new NotFoundError('exchange for request', requestId);
    }
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });

  app.get('/api/staff/order', { preHandler: agent }, (request: FastifyRequest) => {
    const query = parseOr(StaffOrderQuery.safeParse(request.query), 'order read');
    const order = findOrder(ctx.db, query.customerId, query.orderId, ctx.now());
    if (order === null) {
      throw new NotFoundError('order', query.orderId);
    }
    return { order };
  });
}

/**
 * The building side: opening an exchange, and walking it to closure.
 *
 * Initiation is the console verb - the agent on a case starts the exchange for
 * the case's customer and order. The outward leg (`/label`, `/ship`) asserts the
 * old box moved, and `/receive` counts what arrived; `/replace` is where the
 * exchange is actually kept, the point nobody should promise a second
 * replacement after. `/deny` closes an exchange from any non-terminal state,
 * with a reason the customer could be shown.
 */
function registerExchangeBuildRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  registerExchangeOpenRoute(app, ctx, agent);
  registerExchangeAdvanceRoutes(app, ctx, agent);
}

/** Opening an exchange: the console verb that starts the replacement build. */
function registerExchangeOpenRoute(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  app.post<{ Body: unknown }>('/api/staff/exchanges', { preHandler: agent }, (request) => {
    const body = parseOr(CreateExchangeBody.safeParse(request.body), 'exchange request');
    const now = ctx.now();

    let created: { exchangeRecord: ExchangeRecord };
    try {
      created = createExchange(ctx.db, {
        requestId: body.requestId,
        orderId: body.orderId,
        customerId: body.customerId,
        items: body.items,
        reason: body.reason,
        replacementNote: body.replacementNote,
        now,
      });
    } catch (error: unknown) {
      throw toConflict(error);
    }

    const { exchangeRecord } = created;
    audit(
      ctx,
      exchangeRecord,
      'exchange_requested',
      exchangeRecord.requestId === null
        ? `Exchange opened against order ${exchangeRecord.orderId}`
        : `Exchange opened for request ${exchangeRecord.requestId}`,
      now,
    );
    ctx.log.info(
      { exchangeId: exchangeRecord.id, orderId: exchangeRecord.orderId },
      'staff.exchange.requested',
    );
    return {
      exchange: exchangeRecord,
      items: listExchangeItems(ctx.db, exchangeRecord.id),
    };
  });
}

/** Walking an open exchange to closure: label, ship, receive, replace, or deny. */
function registerExchangeAdvanceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {

  app.post<{ Params: unknown; Body: unknown }>('/api/staff/exchanges/:id/label', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const body = parseOr(LabelBody.safeParse(request.body), 'label');
    const now = ctx.now();
    const record = attempt(ctx, id, () => generateExchangeLabel(ctx.db, id, { ...body, now }));
    audit(ctx, record, 'exchange_label_generated', `Label issued via ${body.carrier}`, now);
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/staff/exchanges/:id/ship', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const body = parseOr(ShipBody.safeParse(request.body), 'shipment');
    const now = ctx.now();
    const record = attempt(ctx, id, () => markExchangeShipped(ctx.db, id, { ...body, now }));
    audit(ctx, record, 'exchange_shipped', `Handed to ${body.carrier} as ${body.trackingNumber}`, now);
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/staff/exchanges/:id/receive', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const body = parseOr(ReceiveBody.safeParse(request.body), 'receipt');
    const now = ctx.now();
    const record = attempt(ctx, id, () => markExchangeReceived(ctx.db, id, { lines: body.lines, now }));
    const counted = body.lines.map((line) => `${line.quantity} x ${line.itemId} (${line.condition})`).join(', ');
    audit(ctx, record, 'exchange_received', `Goods received: ${counted}`, now);
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown }>('/api/staff/exchanges/:id/replace', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const now = ctx.now();
    const record = attempt(ctx, id, () => markExchangeReplaced(ctx.db, id, { now }));
    audit(ctx, record, 'exchange_replaced', `Replacement despatched`, now);
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/staff/exchanges/:id/deny', { preHandler: agent }, (request) => {
    const { id } = parseOr(ExchangeIdParams.safeParse(request.params), 'exchange id');
    const body = parseOr(DenyBody.safeParse(request.body), 'denial');
    const now = ctx.now();
    const record = attempt(ctx, id, () => denyExchange(ctx.db, id, { reason: body.reason, now }));
    audit(ctx, record, 'exchange_denied', body.reason, now);
    return { exchange: record, items: listExchangeItems(ctx.db, record.id) };
  });
}