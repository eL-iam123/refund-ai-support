import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CreateRefundRequestSchema, type CreateRefundRequest, type RefundRequestDto } from '@refund/shared';
import type { AppContext } from '../context.js';
import { processRefundRequest, type ProcessResult } from '../../orchestrator.js';
import type { ItemPickerOffer } from '../../retrieval/itemPicker.js';
import { findRequestById } from '../../db/requestRepository.js';
import type { PersistedRequest } from '../../db/records.js';
import { persistDecision } from '../../db/persistDecision.js';
import { rowFromDecision } from '../../db/requestRow.js';
import { pendingDialogueItemIds, recordDialogueTurn } from '../../db/dialogue.js';
import {
  duplicateResponseText,
  findDuplicateReport,
  recordDuplicateAttempt,
  type DuplicateReport,
} from '../../retrieval/duplicates.js';
import { toRequestDto } from '../serialize.js';
import { HttpError, badRequest } from '../errors.js';
import { resolveShopSession, SESSION_COOKIE, type ShopUser } from '../../shop/auth.js';
import { ESCALATION_AGENT, recordAgentMessage, takeoverForEscalated, type ActiveHandoff, type AgentMessage } from '../../db/handoffs.js';
import { isChatClosed } from '../../db/chatClosures.js';
import type { LiveHub } from '../hub.js';
import type { Db } from '../../db/connection.js';
import { findCustomer, findOrder } from '../../db/orderRepository.js';
import { identifyOrder } from '../../retrieval/identifyOrder.js';
import { conversationForOrder } from '../../retrieval/conversation.js';

/**
 * POST /api/chat/messages
 *
 * The only endpoint that runs the pipeline, and the only writer of a
 * `refund_requests` row. That is what makes "every persisted decision came
 * out of the resolver" a property of the code rather than a convention.
 */

type ChatMessageBody = CreateRefundRequest;

/** The 201 body of a message that landed on a live human thread. */
interface HandoffBody {
  readonly received: boolean;
  readonly agentConnected: boolean;
  readonly message: AgentMessage;
  /** A human is attached only after the awaiting-agent slot has been claimed. */
  readonly aiResponse: null;
}

async function handleChatMessage(
  request: FastifyRequest<{ Body: ChatMessageBody }>,
  reply: FastifyReply,
  ctx: AppContext,
  hub: LiveHub,
): Promise<
  | HandoffBody
  | {
      question: string;
      picker: ItemPickerOffer | null;
      notice: string | null;
      dialogueId: string;
      itemIds: readonly string[];
    }
  | { request: RefundRequestDto }
> {
  const body = parseChatBody(request, ctx);
  const session = signedInSession(ctx, request);
  const resolved = withPendingItemScope(ctx, session.customerId, body);
  const now = ctx.now();

  assertThreadOpen(ctx, resolved, now);

  const takeover = takeoverForEscalated(ctx.db, session.customerId, resolved.orderId, now);
  // Only a handoff a person has actually picked up takes the thread away from the
  // pipeline.
  //
  // An unattended escalation - which is what every request becomes when no model
  // is configured, and the single most common state a fresh deployment is in - used
  // to divert here as well, and that is a trap: the customer's message was filed on
  // the handoff thread and the pipeline was skipped, so `aiResponse` came back null
  // and nothing else ever would. With nobody on the console, a thread went silent
  // the moment its first request escalated, and stayed silent however many times
  // the customer wrote in.
  //
  // So the person is still told, and the customer still gets an answer. Escalation
  // is meant to *add* a person to a conversation that the assistant is still having.
  if (takeover !== null && takeover.agentId !== ESCALATION_AGENT) {
    reply.code(201);
    return chatDuringHandoff(ctx, hub, takeover, body.message, now);
  }

  const duplicate = duplicateForSubmission(ctx, resolved, now);
  if (duplicate !== null) {
    return suppressedDuplicate(ctx.db, duplicate, now);
  }

  return await decideOrAsk(ctx, reply, resolved, now);
}

/** The customer this message is from. Never the one in the body. */
function signedInSession(ctx: AppContext, request: FastifyRequest): ShopUser {
  const cookies = request.cookies as Record<string, string | undefined>;
  const session = resolveShopSession(ctx.db, cookies[SESSION_COOKIE], ctx.now());
  if (session === null) {
    throw new HttpError(401, 'unauthorized', 'sign in to start a refund request');
  }
  return session;
}

/**
 * Carries the item scope an unanswered question already holds.
 *
 * The storefront's picker is the customer's way of saying "the mug, not the
 * rest", and it is not repeated on the answer - the answer to "what happened to
 * it?" is "it's cracked", which names no item. So when the previous turn on this
 * order was a question rather than a decision, its scope is adopted here. A
 * caller-supplied `itemIds` always wins, and the scope is only adopted for an
 * order the customer owns.
 */
function withPendingItemScope(
  ctx: AppContext,
  customerId: string,
  body: CreateRefundRequest,
): CreateRefundRequest {
  if (body.itemIds.length > 0 || body.orderId === null) {
    return { ...body, customerId };
  }
  if (findOrder(ctx.db, customerId, body.orderId, ctx.now()) === null) {
    return { ...body, customerId };
  }
  const latestTurn = conversationForOrder(ctx.db, customerId, body.orderId, ctx.now(), 1).at(-1);
  const itemIds = latestTurn?.kind === 'dialogue' ? pendingDialogueItemIds(ctx.db, customerId, body.orderId) : [];
  return { ...body, customerId, itemIds: [...itemIds] };
}

async function decideOrAsk(
  ctx: AppContext,
  reply: FastifyReply,
  resolved: CreateRefundRequest,
  now: Date,
): Promise<
  | {
      question: string;
      picker: ItemPickerOffer | null;
      notice: string | null;
      dialogueId: string;
      itemIds: readonly string[];
    }
  | { request: RefundRequestDto }
> {
  const input: ProcessInputFields = {
    requestId: randomUUID(),
    customerId: resolved.customerId,
    orderId: resolved.orderId,
    message: resolved.message,
    itemIds: resolved.itemIds ?? [],
    now,
  };
  const result = await processRefundRequest(ctx.db, ctx.pipeline, input);
  if (result.stage === 'asked') {
    const turn = recordDialogueTurn(ctx.db, {
      customerId: input.customerId,
      orderId: result.resolvedOrderId,
      customerMessage: input.message,
      assistantQuestion: result.question,
      ...(result.picker === null ? {} : { offer: result.picker }),
      itemIds: result.itemIds,
      now: ctx.now(),
    });
    ctx.log.info({ requestId: input.requestId, question: result.question }, 'chat.asked');
    return {
      question: result.question,
      picker: result.picker,
      notice: result.notice,
      dialogueId: turn.id,
      itemIds: turn.itemIds,
    };
  }

  const stored = storeDecided(ctx, input, result);
  // An escalation is the moment this thread starts needing a person, so the
  // takeover is raised here rather than on the customer's next message. Waiting
  // for the next message would leave the case invisible on the staff console
  // for exactly as long as nobody followed up - which is the case that most
  // needs picking up.
  if (stored.decision === 'escalated') {
    takeoverForEscalated(ctx.db, stored.customerId, stored.orderId, ctx.now());
  }
  reply.code(201);
  // `notice` rides beside the decision rather than inside it: it is what the ladder
  // had to do, not part of the refund, and the client shows it as a line under the
  // answer so an operator reading the thread can see it too.
  return { request: toRequestDto(stored), notice: result.notice };
}

function parseChatBody(
  request: FastifyRequest<{ Body: ChatMessageBody }>,
  ctx: AppContext,
): CreateRefundRequest {
  const body = CreateRefundRequestSchema.safeParse(request.body);
  if (!body.success) {
    throw badRequest(
      'invalid request body',
      body.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  if (body.data.message.length > ctx.env.MAX_MESSAGE_LENGTH) {
    throw badRequest('message is too long', [`message: must be at most ${ctx.env.MAX_MESSAGE_LENGTH} characters`]);
  }
  return body.data;
}

/**
 * A closed thread stays closed.
 *
 * The order has to be resolved first, from the message when the storefront did
 * not name one - otherwise a customer who closed a chat on one order could keep
 * writing, because they happened to leave the order dropdown blank. The check is
 * on the thread, not the request: the point of closing is that the case is over.
 */
function assertThreadOpen(ctx: AppContext, input: CreateRefundRequest, now: Date): void {
  const orderId =
    input.orderId ?? inferOrderIdFromMessage(ctx, input.customerId, input.message, now, input.itemIds ?? []);
  if (orderId !== null && isChatClosed(ctx.db, input.customerId, orderId)) {
    throw new HttpError(
      409,
      'chat_closed',
      'This conversation is closed after its final decision. You can no longer send messages on this order.',
    );
  }
}

/** The order this message is about, or null when it cannot be told. */
function inferOrderIdFromMessage(
  ctx: AppContext,
  customerId: string,
  message: string,
  now: Date,
  itemIds: readonly string[],
): string | null {
  const customer = findCustomer(ctx.db, customerId, now);
  if (customer === null) {
    return null;
  }
  return identifyOrder(ctx.db, customer, null, message, now, itemIds).order?.id ?? null;
}

function duplicateForSubmission(
  ctx: AppContext,
  input: CreateRefundRequest,
  now: Date,
): DuplicateReport | null {
  const customer = findCustomer(ctx.db, input.customerId, now);
  const identified =
    customer === null
      ? null
      : identifyOrder(ctx.db, customer, input.orderId, input.message, now, input.itemIds ?? []);
  return findDuplicateReport(
    ctx.db,
    input.customerId,
    identified?.order?.id ?? null,
    input.message,
    now,
    ctx.env.DUPLICATE_WINDOW_HOURS,
  );
}

/**
 * An escalated thread is now genuinely handed to the staff queue. The model
 * never answers in a human's place: while awaiting a person the customer gets
 * no repeated boilerplate, and after a person claims it only that person may
 * reply. The customer message is durably recorded and announced to staff.
 */
/**
 * A message on a thread a person has taken over.
 *
 * The customer's words go to them, and the assistant stays out of the way - someone
 * is already answering, and two replies is worse than one. The message is also kept
 * on the takeover thread, so the conversation the agent reads is the conversation
 * the customer had.
 */
function chatDuringHandoff(
  ctx: AppContext,
  hub: LiveHub,
  active: ActiveHandoff,
  message: string,
  now: Date,
): HandoffBody {
  const customerMessage = recordAgentMessage(ctx.db, {
    handoffId: active.id,
    sender: 'customer',
    body: message,
    now,
  });

  hub.notifyStaff({ type: 'customer.message', customerId: active.customerId, message: customerMessage });
  hub.notifyStaff({
    type: 'conversation.updated',
    customerId: active.customerId,
    orderId: active.orderId,
  });

  const agentConnected = active.agentId !== ESCALATION_AGENT;
  ctx.log.info(
    { customerId: active.customerId, handoffId: active.id, agentConnected },
    'chat.routed-to-agent',
  );

  return {
    received: true,
    agentConnected,
    message: customerMessage,
    aiResponse: null,
  };
}

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext, hub: LiveHub): void {
  app.post('/api/chat/messages', (request, reply) =>
    handleChatMessage(request as FastifyRequest<{ Body: ChatMessageBody }>, reply, ctx, hub),
  );
}

function storeDecided(
  ctx: AppContext,
  input: ProcessInputFields,
  result: Extract<ProcessResult, { stage: 'decided' }>,
): PersistedRequest {
  const row = rowFromDecision({
    requestId: input.requestId,
    customerId: input.customerId,
    message: input.message,
    now: ctx.now(),
    scenarioId: null,
    result,
  });

  // The reservation lives inside persistDecision rather than here. An approval
  // that reserved nothing is an approval nothing will ever pay, and R-06b would
  // not know to hold the balance - so the two cannot be separated by a caller
  // that forgets one of them.
  persistDecision(ctx.db, row, {
    orderId: result.resolvedOrderId,
    customerId: input.customerId,
    now: ctx.now(),
  });

  ctx.log.info(
    { requestId: input.requestId, decision: row.decision, llmCalled: row.llmCalled },
    'chat.message',
  );

  // Re-read through the repository: the response is the persisted truth, not
  // a second object built from the same inputs.
  const stored = findRequestById(ctx.db, input.requestId);
  if (stored === null) {
    throw new HttpError(500, 'internal_error', 'request row missing immediately after insert');
  }
  return stored;
}

interface ProcessInputFields {
  readonly requestId: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly itemIds: readonly string[];
  readonly now: Date;
}

/**
 * The 200 body for a suppressed repeat.
 *
 * The `request` is the request they already have, re-read from storage rather
 * than rebuilt, so a human override applied since the first submission is what
 * the customer is shown. The `duplicate` block is separate and additive because
 * the storefront has to say *why* the same answer came back - a page that
 * silently re-renders an earlier decision looks broken, and the one thing worse
 * than a duplicate is a duplicate the customer does not know about.
 *
 * 200 rather than 201: nothing was created, and a client that retries on 201
 * semantics would be creating the loop this gate exists to stop.
 */
function suppressedDuplicate(db: Db, duplicate: DuplicateReport, now: Date): {
  request: RefundRequestDto;
  duplicate: { ofRequestId: string; firstReportedAt: string; firstDecision: string };
} {
  recordDuplicateAttempt(db, duplicate.original.id, duplicate, now);
  const stored = findRequestById(db, duplicate.original.id);
  if (stored === null) {
    // The audit event points at a row that vanished. Refusing to answer is
    // better than answering from a null: the customer retries and the gate
    // stops matching once the row is gone.
    throw new HttpError(500, 'internal_error', 'the earlier request this repeats is no longer readable');
  }
  return {
    request: {
      ...toRequestDto(stored),
      responseText: duplicateResponseText(duplicate.original, stored.decision),
    },
    duplicate: {
      ofRequestId: duplicate.original.id,
      firstReportedAt: duplicate.original.createdAt,
      firstDecision: stored.decision,
    },
  };
}
