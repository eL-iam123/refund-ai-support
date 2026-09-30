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
import { activeHandoffForCustomer, recordAgentMessage, type AgentMessage } from '../../db/handoffs.js';
import type { LiveHub } from '../hub.js';
import type { Db } from '../../db/connection.js';

/**
 * POST /api/chat/messages
 *
 * The only endpoint that runs the pipeline, and the only writer of a
 * `refund_requests` row. That is what makes "every persisted decision came
 * out of the resolver" a property of the code rather than a convention.
 */

type ChatMessageBody = CreateRefundRequest;

async function handleChatMessage(
  request: FastifyRequest<{ Body: ChatMessageBody }>,
  reply: FastifyReply,
  ctx: AppContext,
  hub: LiveHub,
): Promise<{ received: boolean; agentConnected: boolean; message: AgentMessage } | { question: string; dialogueId: string } | { request: RefundRequestDto }> {
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

  const active = activeHandoffForCustomer(ctx.db, session.customerId);
  if (active !== null) {
    const message = recordAgentMessage(ctx.db, {
      handoffId: active.id,
      sender: 'customer',
      body: body.data.message,
      now: ctx.now(),
    });
    hub.notifyStaff({ type: 'customer.message', customerId: session.customerId, message });
    hub.notifyStaff({ type: 'conversation.updated', customerId: session.customerId, orderId: active.orderId });
    ctx.log.info({ customerId: session.customerId, handoffId: active.id }, 'chat.routed-to-agent');
    reply.code(201);
    return { received: true, agentConnected: true, message };
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
  reply.code(201);
  return { request: toRequestDto(stored) };
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