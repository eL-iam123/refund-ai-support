import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CreateRefundRequestSchema,
  type ClaimExtraction,
  type CreateRefundRequest,
  type GroundingResult,
  type RefundDecision,
  type RefundRequestDto,
} from '@refund/shared';
import type { AppContext } from '../context.js';
import { processRefundRequest, type ProcessResult } from '../../orchestrator.js';
import { findRequestById, messageFingerprint, type NewRequestRow } from '../../db/requestRepository.js';
import { persistDecision } from '../../db/persistDecision.js';
import {
  duplicateResponseText,
  findDuplicateReport,
  recordDuplicateAttempt,
  type DuplicateReport,
} from '../../retrieval/duplicates.js';
import { toRequestDto } from '../serialize.js';
import { HttpError, badRequest } from '../errors.js';
import { resolveShopSession, SESSION_COOKIE } from '../../shop/auth.js';
import type { Db } from '../../db/connection.js';

/**
 * POST /api/chat/messages
 *
 * The only endpoint that runs the pipeline, and the only writer of a
 * `refund_requests` row. That is what makes "every persisted decision came
 * out of the resolver" a property of the code rather than a convention.
 */
export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/chat/messages', async (request, reply) => {
    const body = CreateRefundRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw badRequest(
        'invalid request body',
        body.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    // Enforced here rather than in the shared schema because the ceiling is
    // operational, not contractual: it is a token-cost control, and the limit
    // belongs to the deployment rather than to the wire format.
    if (body.data.message.length > ctx.env.MAX_MESSAGE_LENGTH) {
      throw badRequest(
        'message is too long',
        [`message: must be at most ${ctx.env.MAX_MESSAGE_LENGTH} characters`],
      );
    }

    // A signed-in shopper cannot choose who they are. Without a session the
    // body value stands, which is why the storefront surfaces this limitation
    // rather than pretending the login closed it: the public chat endpoint is
    // still an unauthenticated surface that trusts `customerId`.
    const cookies = request.cookies as Record<string, string | undefined>;
    const session = resolveShopSession(ctx.db, cookies[SESSION_COOKIE], ctx.now());
    const claimedCustomer = session?.customerId ?? body.data.customerId;

    // The session-resolved customer is what gets persisted, not the body value.
    // Building the row from `body.data` here would store the claimed customer
    // while deciding on the real one, which is the worst of both.
    const resolved: CreateRefundRequest = { ...body.data, customerId: claimedCustomer };
    const now = ctx.now();

    /**
     * The duplicate gate, before the model and before the resolver.
     *
     * Placed here rather than inside the pipeline because the pipeline's output
     * is a decision, and anything the pipeline returns is persisted as one. A
     * duplicate that reached it would be a second decision on the second
     * request row, and an approved decision reserves money - so "recognise the
     * duplicate" has to happen somewhere that can decline to produce a row at
     * all. The customer gets their existing request back instead.
     */
    const duplicate = findDuplicateReport(ctx.db, resolved.customerId, resolved.message, now, ctx.env.DUPLICATE_WINDOW_HOURS);
    if (duplicate !== null) {
      return reply.code(200).send(suppressedDuplicate(ctx.db, duplicate, now));
    }

    const input = toProcessInput(resolved, now);
    const result = await processRefundRequest(ctx.db, ctx.pipeline, input);
    const row = buildRow(input.requestId, resolved, result, ctx.now());

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

    return reply.code(201).send({ request: toRequestDto(stored) });
  });
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

function buildRow(
  requestId: string,
  input: CreateRefundRequest,
  result: ProcessResult,
  now: Date,
): NewRequestRow {
  return {
    id: requestId,
    createdAt: now.toISOString(),
    customerId: input.customerId,
    customerName: result.customer.name,
    orderId: result.resolvedOrderId,
    message: input.message,
    // Lets an auditor prove the stored message was not edited after the
    // decision was made, without keeping a second copy of it anywhere.
    messageSha256: sha256(input.message),
    // Derived from the message here, not accepted from the caller. A caller that
    // supplies its own fingerprint can make two different messages collide, and
    // a duplicate check that can be defeated by choosing a hash is decoration.
    messageFingerprint: messageFingerprint(input.message),
    ...decisionColumns(result.decision),
    responseText: result.responseText,
    extractionJson: toJson(result.extraction),
    groundingJson: toJson(result.grounding),
    injectionJson: JSON.stringify(result.injection),
    aiMode: result.aiMode,
    llmCalled: result.llmCalled,
    timingsJson: JSON.stringify(result.timings),
    scenarioId: null,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function decisionColumns(decision: RefundDecision): Pick<
  NewRequestRow,
  | 'decision'
  | 'refundAmountCents'
  | 'eligibleAmountCents'
  | 'summary'
  | 'policyRef'
  | 'traceJson'
  | 'overridesJson'
  | 'eligibleItemIdsJson'
  | 'blockedItemsJson'
> {
  return {
    decision: decision.decision,
    refundAmountCents: decision.refundAmountCents,
    eligibleAmountCents: decision.eligibleAmountCents,
    summary: decision.summary,
    policyRef: decision.policyRef,
    traceJson: JSON.stringify(decision.trace),
    overridesJson: JSON.stringify(decision.overrides),
    eligibleItemIdsJson: JSON.stringify(decision.eligibleItemIds),
    blockedItemsJson: JSON.stringify(decision.blockedItems),
  };
}

function toJson(value: ClaimExtraction | GroundingResult | null): string | null {
  return value === null ? null : JSON.stringify(value);
}
