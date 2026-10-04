import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict, NotFoundError, UnauthorizedError } from '../errors.js';
import { staffOnly } from '../../auth/guards.js';
import { insertAuditEvent } from '../../db/requestRepository.js';
import { resolveShopSession, SESSION_COOKIE } from '../../shop/auth.js';
import {
  ReturnLedgerError,
  RETURN_STATUSES,
  createReturn,
  denyReturn,
  findReturnById,
  findReturnByRequestId,
  generateReturnLabel,
  listReturnItems,
  listReturns,
  markReturnReceived,
  markReturnShipped,
  processReturn,
  returnTransitions,
  canDenyReturn,
  type ListReturnsFilters,
  type ReturnRecord,
  type ReturnStatus,
} from '../../db/returns.js';

/**
 * Physical returns, kept separate from money.
 *
 * A return is goods travelling back; a refund is money travelling out. They are
 * related but neither implies the other: a damaged item may be refunded without
 * anyone shipping it back, and a gift may be returned with no refund owed at all.
 * Nothing in this file settles a refund. When a return closes, the outcome is
 * recorded and a human decides what it means for the order.
 *
 * Two audiences, two levels of access:
 *
 * - A customer opens and reads their own returns, and asks for one. The customer
 *   comes from the session cookie, never the body, so the only way to name a
 *   customer is to be signed in as them.
 * - Everything that moves a return forward - issuing a label, marking it
 *   shipped, receiving it, processing it, denying it - is staff-only, because
 *   each of those is an assertion about something that physically happened.
 */

const CarrierSchema = z.enum(['usps', 'ups', 'fedex']);

const ReturnIdParams = z.object({ id: z.string().trim().min(1).max(120) });

const ListReturnsQuery = z.object({
  status: z.enum(RETURN_STATUSES).optional(),
  customerId: z.string().trim().min(1).max(120).optional(),
  orderId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateReturnBody = z.object({
  /**
   * The refund request this return answers, if the customer already made one.
   * Omitted for a plain return: sending goods back does not require asking for
   * money first. When present it is the idempotency key, and the ledger refuses
   * a request belonging to another customer or another order.
   */
  requestId: z.string().trim().min(1).max(120).optional(),
  orderId: z.string().trim().min(1).max(120),
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
});

const LabelBody = z.object({
  carrier: CarrierSchema.default('usps'),
  /**
   * The label is bought from a carrier elsewhere and the resulting URL passed
   * in. It is not synthesised here: a URL that looks right and 404s is worse
   * than a visible failure, because the customer only finds out after they have
   * already packed the box.
   */
  labelUrl: z.string().trim().url().max(500),
});

const ShipBody = z.object({
  carrier: CarrierSchema,
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

/**
 * Restocking is named by order line, never by product.
 *
 * The server resolves line -> product through the return, so the only product
 * that can be credited with stock is one the customer actually sent back. A
 * `productId` here would be a free-text way to say "add units of X", which is
 * the one thing a warehouse operator should not be able to do by accident.
 */
const ProcessBody = z.object({
  restock: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(0).max(1000),
      }),
    )
    .max(50)
    .default([]),
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
 * An illegal state change is a 409, not a 500.
 *
 * Marking a return shipped twice, or receiving one that was already denied, is
 * what a duplicate webhook or a double-clicking warehouse operator looks like.
 * Both are ordinary answers, and answering them as server errors would teach
 * staff that this screen is broken rather than telling them what happened.
 */
function toConflict(error: unknown): Error {
  if (error instanceof ReturnLedgerError) {
    return conflict('return_conflict', error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs a ledger transition, turning a rejected move into a 409.
 *
 * Existence is checked here rather than inferred from the ledger's error text.
 * A missing return is a typo - "return RET-99 does not exist" and "return
 * RET-99 is already received" need different reactions - and the difference is
 * worth one cheap lookup, because reading it off an error string means the
 * mapping silently breaks the first time a message is reworded.
 */
function attempt(ctx: AppContext, id: string, move: () => ReturnRecord): ReturnRecord {
  existingOr404(ctx, id);
  try {
    return move();
  } catch (error: unknown) {
    throw toConflict(error);
  }
}

/** The signed-in shopper, or 401. Returns never take a customer id from the body. */
function customerFor(ctx: AppContext, request: FastifyRequest): string {
  const token = request.cookies[SESSION_COOKIE];
  const session = resolveShopSession(ctx.db, token, ctx.now());
  if (session === null) {
    throw new UnauthorizedError('sign in to open or track a return');
  }
  return session.customerId;
}

function existingOr404(ctx: AppContext, id: string): ReturnRecord {
  const found = findReturnById(ctx.db, id);
  if (found === null) {
    throw new NotFoundError('return', id);
  }
  return found;
}

/**
 * Records who moved a return and why.
 *
 * A return's status is something a support agent reads before telling a
 * customer their money is on the way, so the transition is audited rather than
 * left implicit in a row's timestamp.
 *
 * The audit chain is keyed by request id, and a return does not always have
 * one - sending something back need not involve asking for money. Those are
 * filed under `return:<id>`, a key that cannot collide with a request id because
 * `:` is not in the id character set. The alternative, skipping the audit for
 * request-less returns, would mean the one class of return with no money
 * attached is also the one with no trail.
 */
function audit(ctx: AppContext, record: ReturnRecord, kind: string, detail: string, at: Date): void {
  insertAuditEvent(ctx.db, auditSubject(record), at.toISOString(), kind, detail);
}

function auditSubject(record: ReturnRecord): string {
  return record.requestId ?? `return:${record.id}`;
}

export function registerReturnsRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerCustomerRoutes(app, ctx);
  registerStaffRoutes(app, ctx, staffOnly(ctx.env, 'agent', ctx.now));
}

/**
 * Spreads a parsed query into ledger filters.
 *
 * Built field by field rather than spread, because the project compiles with
 * `exactOptionalPropertyTypes`: a parsed query carries explicit `undefined` for
 * the fields that were not sent, and the ledger's filters mean "absent" by not
 * being there at all.
 */
function filtersFrom(
  query: z.infer<typeof ListReturnsQuery>,
  scope: { readonly customerId?: string } = {},
): ListReturnsFilters {
  const filters: { status?: ReturnStatus; customerId?: string; orderId?: string; limit: number } = {
    limit: query.limit,
  };
  if (query.status !== undefined) {
    filters.status = query.status;
  }
  if (query.orderId !== undefined) {
    filters.orderId = query.orderId;
  }
  if (scope.customerId !== undefined) {
    filters.customerId = scope.customerId;
  }
  return filters;
}

/**
 * What a shopper can do: see their own returns, and ask for one.
 *
 * The customer id is resolved from the session and then used to scope the
 * lookup, so a guessed return id from another account reads as 404 rather than
 * as somebody else's parcel.
 */
function registerCustomerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/returns', (request: FastifyRequest) => {
    const query = parseOr(ListReturnsQuery.safeParse(request.query), 'return filter');
    const customerId = customerFor(ctx, request);
    // The filter a customer sends can only ever narrow their own returns.
    return { returns: listReturns(ctx.db, filtersFrom(query, { customerId })) };
  });

  app.post<{ Body: unknown }>('/api/returns', (request) => {
    const body = parseOr(CreateReturnBody.safeParse(request.body), 'return request');
    const customerId = customerFor(ctx, request);

    let created: { returnRecord: ReturnRecord };
    try {
      created = createReturn(ctx.db, { ...body, customerId, now: ctx.now() });
    } catch (error: unknown) {
      throw toConflict(error);
    }

    const { returnRecord } = created;
    audit(
      ctx,
      returnRecord,
      'return_requested',
      returnRecord.requestId === null
        ? `Return opened against order ${returnRecord.orderId}`
        : `Return opened for request ${returnRecord.requestId}`,
      ctx.now(),
    );
    ctx.log.info({ returnId: returnRecord.id, orderId: returnRecord.orderId }, 'return.requested');
    return { return: returnRecord, items: listReturnItems(ctx.db, returnRecord.id) };
  });

  app.get<{ Params: unknown }>('/api/returns/:id', (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const customerId = customerFor(ctx, request);
    const record = findReturnById(ctx.db, id);
    if (record === null || record.customerId !== customerId) {
      // Deliberately 404 rather than 403: confirming that somebody else's return
      // exists is itself a small leak, and the caller learns nothing useful.
      throw new NotFoundError('return', id);
    }
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });
}

/**
 * Everything that advances a return.
 *
 * Each of these asserts that something happened in the physical world - a label
 * was bought, a parcel left, goods arrived at a bench, a decision was made. A
 * customer cannot assert any of that about themselves without someone else
 * confirming it, so the whole set is staff-only.
 */
function registerStaffRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  registerReturnReadRoutes(app, ctx, agent);
  registerReturnForwardRoutes(app, ctx, agent);
  registerReturnCloseoutRoutes(app, ctx, agent);
}

/** The warehouse and support view: everything, and one return in detail. */
function registerReturnReadRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  app.get('/api/admin/returns', { preHandler: agent }, (request: FastifyRequest) => {
    const query = parseOr(ListReturnsQuery.safeParse(request.query), 'return filter');
    return { returns: listReturns(ctx.db, filtersFrom(query)) };
  });

  app.get<{ Params: unknown }>('/api/admin/returns/:id', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const record = existingOr404(ctx, id);
    return {
      return: record,
      items: listReturnItems(ctx.db, id),
      // Which moves are legal from here, published rather than restated in the UI.
      // A page that keeps its own copy of this table drifts, and the drift shows up
      // as a button that offers an illegal move - which is how a parcel gets marked
      // received twice.
      nextStates: returnTransitions(record.status),
      canDeny: canDenyReturn(record.status),
    };
  });

  app.get<{ Params: unknown }>('/api/admin/returns/by-request/:requestId', { preHandler: agent }, (request) => {
    const { requestId } = parseOr(
      z.object({ requestId: z.string().trim().min(1).max(120) }).safeParse(request.params),
      'request id',
    );
    const record = findReturnByRequestId(ctx.db, requestId);
    if (record === null) {
      throw new NotFoundError('return for request', requestId);
    }
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });
}

/**
 * The parcel moving outwards: a label is bought, then the box goes.
 *
 * Split from the closeout transitions because they assert opposite things. These
 * say the customer has it and is sending it; the closeout set says we have it.
 * Keeping them apart is why there is no single "advance the return" endpoint that
 * could do both.
 */
function registerReturnForwardRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  app.post<{ Params: unknown; Body: unknown }>('/api/admin/returns/:id/label', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const body = parseOr(LabelBody.safeParse(request.body), 'label');
    const now = ctx.now();
    const record = attempt(ctx, id, () => generateReturnLabel(ctx.db, id, { ...body, now }));
    audit(ctx, record, 'return_label_generated', `Label issued via ${body.carrier}`, now);
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/admin/returns/:id/ship', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const body = parseOr(ShipBody.safeParse(request.body), 'shipment');
    const now = ctx.now();
    const record = attempt(ctx, id, () => markReturnShipped(ctx.db, id, { ...body, now }));
    audit(ctx, record, 'return_shipped', `Handed to ${body.carrier} as ${body.trackingNumber}`, now);
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });
}

/**
 * The parcel arriving, and what happens to the goods.
 *
 * Note what is absent: no money. A return being processed is a fact about stock.
 * What it means for the customer's money is decided by the policy engine on its
 * own request and still has to pass a human, so there is deliberately no path
 * from "goods are back" to "refund is paid".
 */
function registerReturnCloseoutRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  agent: (request: FastifyRequest) => Promise<void>,
): void {
  app.post<{ Params: unknown; Body: unknown }>('/api/admin/returns/:id/receive', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const body = parseOr(ReceiveBody.safeParse(request.body), 'receipt');
    const now = ctx.now();
    const record = attempt(ctx, id, () => markReturnReceived(ctx.db, id, { lines: body.lines, now }));
    const counted = body.lines.map((line) => `${line.quantity} x ${line.itemId} (${line.condition})`).join(', ');
    audit(ctx, record, 'return_received', `Goods received: ${counted}`, now);
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/admin/returns/:id/process', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const body = parseOr(ProcessBody.safeParse(request.body ?? {}), 'processing');
    const now = ctx.now();
    const record = attempt(ctx, id, () => processReturn(ctx.db, id, { restock: body.restock, now }));
    audit(ctx, record, 'return_processed', `${body.restock.length} line(s) restocked`, now);
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });

  app.post<{ Params: unknown; Body: unknown }>('/api/admin/returns/:id/deny', { preHandler: agent }, (request) => {
    const { id } = parseOr(ReturnIdParams.safeParse(request.params), 'return id');
    const body = parseOr(DenyBody.safeParse(request.body), 'denial');
    const now = ctx.now();
    const record = attempt(ctx, id, () => denyReturn(ctx.db, id, { reason: body.reason, now }));
    audit(ctx, record, 'return_denied', body.reason, now);
    return { return: record, items: listReturnItems(ctx.db, record.id) };
  });
}
