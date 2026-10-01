import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CreateRefundRequestSchema, type CreateRefundRequest, type RefundRequestDto } from '@refund/shared';
import type { AppContext } from '../context.js';
import { processRefundRequest, type ProcessResult } from '../../orchestrator.js';
import { findRequestById } from '../../db/requestRepository.js';
import type { PersistedRequest } from '../../db/records.js';
import { persistDecision } from '../../db/persistDecision.js';
import { rowFromDecision } from '../../db/requestRow.js';
import { recordDialogueTurn } from '../../db/dialogue.js';
import {
  duplicateResponseText,
  findDuplicateReport,
  recordDuplicateAttempt,
  type DuplicateReport,
} from '../../retrieval/duplicates.js';
import { toRequestDto } from '../serialize.js';
import { HttpError, badRequest } from '../errors.js';
import { resolveShopSession, SESSION_COOKIE } from '../../shop/auth.js';
import { recordAgentMessage, takeoverForEscalated, type ActiveHandoff, type AgentMessage } from '../../db/handoffs.js';
import type { LiveHub } from '../hub.js';
import type { Db } from '../../db/connection.js';
import { toAnalyzerOrder } from '../../ai/openaiAnalyzer.js';
import { transcriptForOrder } from '../../retrieval/conversation.js';
import { findOrder } from '../../db/orderRepository.js';
import type { ChatInput, ChatReply } from '../../ai/analyzer.js';

/**
 * POST /api/chat/messages
 *
 * The only endpoint that runs the pipeline, and the only writer of a
 * `refund_requests` row. That is what makes "every persisted decision came
 * out of the resolver" a property of the code rather than a convention.
 */

type ChatMessageBody = CreateRefundRequest;

/** How much of the thread the escalated assistant is shown each turn. */
const CHAT_HISTORY_LIMIT = 20;

/** The 201 body of a message that landed on a live human thread. */
interface HandoffBody {
  readonly received: boolean;
  readonly agentConnected: boolean;
  readonly message: AgentMessage;
  /** The assistant's conversational reply, or null when it only called a tool. */
  readonly aiResponse: string | null;
}

async function handleChatMessage(
  request: FastifyRequest<{ Body: ChatMessageBody }>,
  reply: FastifyReply,
  ctx: AppContext,
  hub: LiveHub,
): Promise<HandoffBody | { question: string; dialogueId: string } | { request: RefundRequestDto }> {
  const body = CreateRefundRequestSchema.safeParse(request.body);
  if (!body.success) {
    throw badRequest(
      'invalid request body',
      body.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  if (body.data.message.length > ctx.env.MAX_MESSAGE_LENGTH) {
    throw badRequest(
      'message is too long',
      [`message: must be at most ${ctx.env.MAX_MESSAGE_LENGTH} characters`],
    );
  }

  const cookies = request.cookies as Record<string, string | undefined>;
  const session = resolveShopSession(ctx.db, cookies[SESSION_COOKIE], ctx.now());
  if (session === null) {
    throw new HttpError(401, 'unauthorized', 'sign in to start a refund request');
  }
  const resolved: CreateRefundRequest = { ...body.data, customerId: session.customerId };
  const now = ctx.now();

  const takeover = takeoverForEscalated(ctx.db, session.customerId, resolved.orderId, now);
  if (takeover !== null) {
    reply.code(201);
    return await chatDuringHandoff(ctx, hub, takeover, body.data.message, now);
  }

  const duplicate = findDuplicateReport(ctx.db, resolved.customerId, resolved.message, now, ctx.env.DUPLICATE_WINDOW_HOURS);
  if (duplicate !== null) {
    return suppressedDuplicate(ctx.db, duplicate, now);
  }

  const input = toProcessInput(resolved, now);
  const result = await processRefundRequest(ctx.db, ctx.pipeline, input);

  if (result.stage === 'asked') {
    const turn = recordDialogueTurn(ctx.db, {
      customerId: input.customerId,
      orderId: null,
      customerMessage: input.message,
      assistantQuestion: result.question,
      now: ctx.now(),
    });
    ctx.log.info({ requestId: input.requestId, question: result.question }, 'chat.asked');
    return { question: result.question, dialogueId: turn.id };
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
  return { request: toRequestDto(stored) };
}

/**
 * The escalated path: a person is live on the thread, so the pipeline is
 * bypassed entirely and the model becomes a conversational assistant with no
 * monetary authority. Its only tool is `remind_admin`, which nudges the staff
 * console when the customer is pushing for a person.
 */
async function chatDuringHandoff(
  ctx: AppContext,
  hub: LiveHub,
  active: ActiveHandoff,
  message: string,
  now: Date,
): Promise<HandoffBody> {
  const history = transcriptForOrder(ctx.db, active.customerId, active.orderId, now, CHAT_HISTORY_LIMIT);
  const order = active.orderId === null ? null : findOrder(ctx.db, active.customerId, active.orderId, now);
  const chatInput: ChatInput = {
    message,
    order: toAnalyzerOrder(order),
    history,
    tools: [
      {
        name: 'remind_admin',
        description: 'Notify the human agent that the customer is waiting or pushing for a response.',
      },
    ],
  };

  const customerMessage = recordAgentMessage(ctx.db, { handoffId: active.id, sender: 'customer', body: message, now });
  const reply = await askAssistant(ctx, chatInput);

  if (reply.kind === 'tool_call') {
    hub.notifyStaff({ type: 'customer.pushing', customerId: active.customerId, orderId: active.orderId });
  } else if (reply.kind === 'text') {
    recordAgentMessage(ctx.db, { handoffId: active.id, sender: 'agent', body: reply.text, now });
  }

  hub.notifyStaff({ type: 'customer.message', customerId: active.customerId, message: customerMessage });
  hub.notifyStaff({ type: 'conversation.updated', customerId: active.customerId, orderId: active.orderId });
  ctx.log.info({ customerId: active.customerId, handoffId: active.id, ai: reply.kind }, 'chat.routed-to-agent');

  return {
    received: true,
    agentConnected: true,
    message: customerMessage,
    aiResponse: reply.kind === 'text' ? reply.text : null,
  };
}

/**
 * One attempt at the conversational reply, degrading to nothing when the model
 * is unreachable.
 *
 * The customer's message is already recorded by the time this runs, so a failure
 * here costs the thread a reply rather than the thread its turn: the person on
 * the line still sees the customer, which is the only thing that matters.
 */
async function askAssistant(ctx: AppContext, input: ChatInput): Promise<ChatReply | { kind: 'failed' }> {
  try {
    return await ctx.pipeline.analyzer.chat(input, (attempt) =>
      ctx.pipeline.recordAttempt('chat', ctx.pipeline.analyzer.label, attempt),
    );
  } catch (error) {
    ctx.log.error({ err: error }, 'chat.failed');
    return { kind: 'failed' };
  }
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
    orderId: input.orderId,
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

function toProcessInput(data: CreateRefundRequest, now: Date): ProcessInputFields {
  return {
    requestId: randomUUID(),
    customerId: data.customerId,
    orderId: data.orderId,
    message: data.message,
    now,
  };
}