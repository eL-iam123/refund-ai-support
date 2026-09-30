import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { LiveHub } from '../hub.js';
import { staffOnly } from '../../auth/guards.js';
import type { Principal } from '../../auth/tokens.js';
import { NotFoundError, HttpError, badRequest } from '../errors.js';
import { findCustomer } from '../../db/sql.js';
import {
  activeHandoffForCustomer,
  endHandoff,
  listConversationCandidates,
  recordAgentMessage,
  startHandoff,
  HandoffAlreadyActiveError,
  NoActiveHandoffError,
  type ActiveHandoff,
  type AgentMessage,
  type ConversationCandidate,
} from '../../db/handoffs.js';
import { threadForStaff } from '../../retrieval/conversation.js';
import { buildHandoffBrief } from '../../report/handoffBrief.js';

/**
 * Staff endpoints for the live takeover console.
 *
 * The customer interface for the same feature lives in the ordinary chat route -
 * a customer never learns about "takeover" as a noun, their message is just
 * answered and the "connecting you to a customer agent" notice appears - but the
 * writing side is all here. Four verbs, each one a row in the agreement between
 * the automatic assistant and the human:
 *
 *  - **list** the conversations an agent might pick up;
 *  - **take over** a thread, which pokes the customer and every other agent;
 *  - **message** the customer, over the same thread the assistant was using;
 *  - **hand back**, which reconnects the pipeline.
 *
 * Authorization is `agent` for everything: messaging a customer is reading and
 * writing their thread, the same act an override performs but without the money
 * attached. Separate humans, separate permissions.
 */

const TakeOverSchema = z.object({
  orderId: z.string().min(1).nullable(),
});

const StaffMessageSchema = z.object({
  body: z.string().max(4000).optional(),
});

const ConversationQuerySchema = z.object({
  customerId: z.string().min(1),
  orderId: z.string().min(1).nullable().optional(),
});

/** How far back a conversation must have moved to count as "live". */
const LIVE_WINDOW_HOURS = 24;

function requirePrincipal(principal: Principal | undefined): Principal {
  if (principal === undefined) {
    // Behind `staffOnly` this cannot happen; a missing principal is wiring.
    throw new Error('staff conversation route reached without an authenticated principal');
  }
  return principal;
}

export function registerStaffConversationRoutes(app: FastifyInstance, ctx: AppContext, hub: LiveHub): void {
  const staff = (role: 'agent' | 'admin') => ({
    preHandler: staffOnly(ctx.env, role, ctx.now),
  });

  app.get('/api/staff/conversations', staff('agent'), () => listConversations(ctx));
  app.get('/api/staff/conversation', staff('agent'), (request) => openConversation(ctx, request));
  app.post('/api/staff/conversations/:customerId/take-over', staff('agent'), (request) => takeOver(ctx, hub, request));
  app.post('/api/staff/conversations/:customerId/message', staff('agent'), (request) => messageCustomer(ctx, hub, request));
  app.post('/api/staff/conversations/:customerId/hand-back', staff('agent'), (request) => handBack(ctx, hub, request));
}

/** The conversations an agent might pick up, ordered by who moved last. */
function listConversations(ctx: AppContext): { conversations: readonly ConversationCandidate[] } {
  const now = ctx.now();
  const since = new Date(now.getTime() - LIVE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  return { conversations: listConversationCandidates(ctx.db, since, 50) };
}

function openConversation(
  ctx: AppContext,
  request: FastifyRequest,
): { thread: unknown; brief: unknown } {
  const query = ConversationQuerySchema.safeParse(request.query);
  if (!query.success) {
    throw badRequest('invalid query', query.error.issues.map((issue) => issue.message));
  }
  const { customerId, orderId } = query.data;
  if (findCustomer(ctx.db, customerId, ctx.now()) === null) {
    throw new NotFoundError('customer', customerId);
  }
  return {
    thread: threadForStaff(ctx.db, customerId, orderId ?? null, 200),
    brief: buildHandoffBrief(ctx.db, customerId, orderId ?? null),
  };
}

function takeOver(
  ctx: AppContext,
  hub: LiveHub,
  request: FastifyRequest,
): { handoff: ActiveHandoff } {
  const params = request.params as { customerId: string };
  const body = TakeOverSchema.safeParse(request.body);
  if (!body.success) {
    throw badRequest(
      'invalid take-over',
      body.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  if (findCustomer(ctx.db, params.customerId, ctx.now()) === null) {
    throw new NotFoundError('customer', params.customerId);
  }

  const agentId = requirePrincipal(request.principal).subject;
  let handoff: ActiveHandoff;
  try {
    handoff = startHandoff(ctx.db, {
      customerId: params.customerId,
      orderId: body.data.orderId,
      agentId,
      now: ctx.now(),
    });
  } catch (error) {
    if (error instanceof HandoffAlreadyActiveError) {
      // 409, not a refusal with a body that names the other agent: two agents
      // racing to help the same customer is the race this guard exists to make
      // impossible, so the loser learns it was too late, and nothing else.
      throw new HttpError(409, 'handoff_already_active', 'this customer already has a customer agent attached');
    }
    throw error;
  }

  ctx.log.info(
    { customerId: params.customerId, handoffId: handoff.id, agentId },
    'staff.handoff.started',
  );

  hub.notifyStaff({
    type: 'handoff.started',
    customerId: params.customerId,
    orderId: handoff.orderId,
    agentId: handoff.agentId,
    since: handoff.startedAt,
  });
  hub.notifyCustomer(params.customerId, {
    type: 'agent.connected',
    customerId: params.customerId,
    agentId: handoff.agentId,
    since: handoff.startedAt,
  });

  return { handoff };
}

function messageCustomer(
  ctx: AppContext,
  hub: LiveHub,
  request: FastifyRequest,
): { message: AgentMessage } {
  const params = request.params as { customerId: string };
  const body = StaffMessageSchema.safeParse(request.body);
  const text = body.success && body.data.body !== undefined ? body.data.body.trim() : '';
  if (!body.success || text.length === 0) {
    throw badRequest('invalid message', ['body: must be a non-empty message']);
  }

  const active = activeHandoffForCustomer(ctx.db, params.customerId);
  if (active === null) {
    throw new HttpError(409, 'no_active_handoff', 'only a customer agent attached to this thread can message the customer');
  }

  const message: AgentMessage = recordAgentMessage(ctx.db, {
    handoffId: active.id,
    sender: 'agent',
    body: text,
    now: ctx.now(),
  });

  hub.notifyCustomer(params.customerId, {
    type: 'agent.message',
    customerId: params.customerId,
    message,
  });
  hub.notifyStaff({
    type: 'conversation.updated',
    customerId: params.customerId,
    orderId: active.orderId,
  });

  return { message };
}

function handBack(
  ctx: AppContext,
  hub: LiveHub,
  request: FastifyRequest,
): { ended: ActiveHandoff } {
  const params = request.params as { customerId: string };

  let ended: ActiveHandoff | null;
  try {
    ended = endHandoff(ctx.db, params.customerId, ctx.now());
  } catch (error) {
    if (error instanceof NoActiveHandoffError) {
      throw new HttpError(409, 'no_active_handoff', 'this customer has no customer agent attached');
    }
    throw error;
  }
  if (ended === null) {
    // endHandoff returns null rather than throwing for a missing takeover;
    // the two API callers just get the same 409 either way.
    throw new HttpError(409, 'no_active_handoff', 'this customer has no customer agent attached');
  }

  ctx.log.info(
    { customerId: params.customerId, handoffId: ended.id },
    'staff.handoff.ended',
  );

  hub.notifyCustomer(params.customerId, {
    type: 'agent.left',
    customerId: params.customerId,
    orderId: ended.orderId,
  });
  hub.notifyStaff({
    type: 'handoff.ended',
    customerId: params.customerId,
    orderId: ended.orderId,
  });

  return { ended };
}