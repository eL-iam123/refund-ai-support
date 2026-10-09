import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CreateRefundRequestSchema, type CreateRefundRequest, type RefundRequestDto, type Stage } from '@refund/shared';
import type { AppContext } from '../context.js';
import { confirmingClaimText, processRefundRequest, type ProcessResult } from '../../orchestrator.js';
import type { ItemPickerOffer } from '../../retrieval/itemPicker.js';
import { findRequestById, latestRequestForThread, insertAuditEvent } from '../../db/requestRepository.js';
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
import { ESCALATION_AGENT, forkForMessage, recordAgentMessage, takeoverForEscalated, type ActiveHandoff, type AgentMessage } from '../../db/handoffs.js';
import { isChatClosed } from '../../db/chatClosures.js';
import type { LiveHub } from '../hub.js';
import type { Db } from '../../db/connection.js';
import { findCustomer, findOrder } from '../../db/orderRepository.js';
import { asksForMoney, wantsAnAgent } from '../../response/intent.js';
import { detectedReason } from '../../ai/reasonVocabulary.js';
import { scanForInjection } from '../../security/injection.js';
import { identifyOrder, type Identification } from '../../retrieval/identifyOrder.js';
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
      progressStage: Stage;
    }
  | { request: RefundRequestDto }
  | { status: string; requestId: string }
> {
  const body = parseChatBody(request, ctx);
  const session = signedInSession(ctx, request);
  const resolved = withPendingItemScope(ctx, session.customerId, body);
  const now = ctx.now();

  const customer = findCustomer(ctx.db, session.customerId, now);
  const identification: Identification =
    customer === null
      ? { order: null, basis: 'unresolved', candidates: 0, items: [], evidence: 'customer not found' }
      : identifyOrder(ctx.db, customer, resolved.orderId, resolved.message, now, resolved.itemIds ?? []);

  assertThreadOpen(ctx, resolved, now, identification);

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
    const forkReply = claimedTakeoverReply(ctx, reply, hub, takeover, resolved, identification, now);
    if (forkReply !== null) {
      return forkReply;
    }
  }

  const duplicate = duplicateForSubmission(ctx, resolved, now, identification);
  if (duplicate !== null) {
    return suppressedDuplicate(ctx.db, duplicate, now);
  }

  // A follow-up on a thread whose case is already open must not open a second
  // one: without this, every "thanks" or "you said it was escalated" after a
  // hand-back runs a fresh pipeline, persists a fresh escalation, and raises a
  // fresh takeover for the same complaint.
  const openCase = openCaseStatus(ctx.db, session.customerId, resolved, now, identification);
  if (openCase !== null) {
    reply.code(200);
    return openCase;
  }

  return await decideOrAsk(ctx, reply, resolved, now, identification);
}

/**
 * Answers a message that arrived while a person has the thread.
 *
 * The fork scope decides: a takeover forked from a decided escalation answers
 * only for its own case's follow-ups, so a message about anything else falls
 * through (null) to the pipeline below and starts its own case. A pre-fork
 * takeover has no recorded scope and keeps the old whole-thread reach.
 */
function claimedTakeoverReply(
  ctx: AppContext,
  reply: FastifyReply,
  hub: LiveHub,
  takeover: ActiveHandoff,
  resolved: CreateRefundRequest,
  identification: Identification,
  now: Date,
): HandoffBody | null {
  if (takeover.requestId === null) {
    reply.code(201);
    return chatDuringHandoff(ctx, hub, takeover, resolved.message, now);
  }
  const fork = forkForMessage(ctx.db, takeover.customerId, {
    orderId: resolved.orderId ?? identification.order?.id ?? null,
    itemIds: resolved.itemIds ?? [],
  });
  if (fork !== null && fork.handoff.id === takeover.id) {
    reply.code(201);
    return chatDuringHandoff(ctx, hub, takeover, resolved.message, now);
  }
  return null;
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
  const pending = latestTurn?.kind === 'dialogue'
    ? pendingDialogueItemIds(ctx.db, customerId, body.orderId)
    : [];
  const currentItems = new Set(
    (ctx.db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(body.orderId) as { id: string }[]).map((r) => r.id),
  );
  const valid = pending.filter((id) => currentItems.has(id));
  return { ...body, customerId, itemIds: [...valid] };
}

async function decideOrAsk(
  ctx: AppContext,
  reply: FastifyReply,
  resolved: CreateRefundRequest,
  now: Date,
  identification: Identification,
): Promise<
  | {
      question: string;
      picker: ItemPickerOffer | null;
      notice: string | null;
      dialogueId: string;
      itemIds: readonly string[];
      progressStage: Stage;
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
  const result = await processRefundRequest(ctx.db, ctx.pipeline, { ...input, identification });
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
      // The conversation is at intake: a question is what intake returns, and there is
      // no decided request to read a stage from yet.
      progressStage: 'intake',
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
function assertThreadOpen(ctx: AppContext, input: CreateRefundRequest, _now: Date, identification: Identification): void {
  const orderId = input.orderId ?? identification.order?.id ?? null;
  if (orderId !== null && isChatClosed(ctx.db, input.customerId, orderId)) {
    throw new HttpError(
      409,
      'chat_closed',
      'This conversation is closed after its final decision. You can no longer send messages on this order.',
    );
  }
}

function duplicateForSubmission(
  ctx: AppContext,
  input: CreateRefundRequest,
  now: Date,
  identification: Identification,
): DuplicateReport | null {
  // A confirmation answer is never a repeat: "yes" collides with every other
  // short answer on the order, and suppressing it would answer a question the
  // customer just said yes to with a decision made for someone else's words.
  const orderId = input.orderId ?? identification.order?.id ?? null;
  if (
    orderId !== null &&
    confirmingClaimText(ctx.db, input.customerId, orderId, input.message) !== null
  ) {
    return null;
  }
  return findDuplicateReport(
    ctx.db,
    input.customerId,
    identification.order?.id ?? null,
    input.message,
    now,
    ctx.env.DUPLICATE_WINDOW_HOURS,
  );
}

/**
 * What the customer is told when they write back on a thread whose case is
 * already open.
 *
 * Worded to match the escalation it refers to: the case is open, nobody needs
 * anything from them, and new information still has somewhere to go.
 */
const OPEN_CASE_STATUS =
  'A person is still reviewing your request — nothing further is needed from you. ' +
  'If something new has gone wrong, just describe it here.';

/**
 * Answers a follow-up from the open case instead of opening a second one.
 *
 * Returns null unless all three hold: the thread's latest request is an
 * escalation nobody has overridden, the message states no new claim, and it
 * names no item outside the open case's claim. Anything else - a fault
 * described, money asked, a person requested, an injection probe, or a
 * different line named - runs the full pipeline, because that message may be
 * a new case wearing a familiar thread.
 *
 * The item check is the part patterns cannot do: "what about the lamp?" has
 * no fault words, so the signal gate calls it a follow-up - but when the open
 * case is about the mug, it is a new case about the lamp, and answering it
 * with the open-case status would quietly lose a complaint. Bias is
 * deliberate: a duplicate case is triage noise, a swallowed one is a refund
 * quietly lost.
 *
 * Nothing is persisted except an audit event on the open request, so there is
 * no second decision row and no second takeover for staff to triage. A 200,
 * like the duplicate path: nothing was created.
 */
function openCaseStatus(
  db: Db,
  customerId: string,
  input: CreateRefundRequest,
  now: Date,
  identification: Identification,
): { status: string; requestId: string } | null {
  const orderId = input.orderId ?? identification.order?.id ?? null;
  if (orderId === null) {
    return null;
  }
  // A confirmation answer is not a follow-up: it completes the case the
  // confirmation question offered, so answering it with the open-case status
  // would swallow the "yes" and the case would never close.
  if (confirmingClaimText(db, customerId, orderId, input.message) !== null) {
    return null;
  }
  const latest = openEscalation(db, customerId, orderId);
  if (latest === null || statesNewClaim(input.message)) {
    return null;
  }
  if (aboutDifferentItems(input, identification, latest.claimItemIdsJson)) {
    return null;
  }
  insertAuditEvent(
    db,
    latest.id,
    now.toISOString(),
    'followup_on_open_case',
    JSON.stringify({ message: input.message.slice(0, 200) }),
  );
  return { status: OPEN_CASE_STATUS, requestId: latest.id };
}

/**
 * Whether the message could be a new claim rather than talk about the open one.
 *
 * Deliberately the same signals the pipeline itself treats as claim-shaped: a
 * stated fault, a money ask, a person request, or an injection probe (which
 * R-14 must still see and record rather than have answered away quietly).
 */
function statesNewClaim(message: string): boolean {
  return (
    detectedReason(message) !== null ||
    asksForMoney(message) ||
    wantsAnAgent(message) ||
    scanForInjection(message).detected
  );
}

/**
 * The thread's open escalation, if the thread has one.
 *
 * Open means decided-escalated with nobody overriding it since: anything
 * else is either still being decided or already resolved, and neither wants
 * the follow-up treatment.
 */
function openEscalation(
  db: Db,
  customerId: string,
  orderId: string,
): PersistedRequest | null {
  const latest = latestRequestForThread(db, customerId, orderId);
  if (latest === null || latest.decision !== 'escalated' || latest.overriddenBy !== null) {
    return null;
  }
  return latest;
}

/**
 * Whether the message names lines outside the open case's claim.
 *
 * Both scopes have to be known: an empty identification means the message
 * named nothing resolvable, and an empty claim means the case itself never
 * scoped - either way there is nothing to compare, so it stays a follow-up.
 * Disjoint non-empty scopes mean different items, which is a different case
 * no matter how politely it is phrased.
 */
function aboutDifferentItems(
  input: CreateRefundRequest,
  identification: Identification,
  claimItemIdsJson: string,
): boolean {
  const ticked = input.itemIds.length > 0 ? input.itemIds : [];
  const named = ticked.length > 0 ? ticked : identification.items.map((item) => item.id);
  if (named.length === 0) {
    return false;
  }
  let claimed: unknown;
  try {
    claimed = JSON.parse(claimItemIdsJson) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(claimed)) {
    return false;
  }
  const claimedIds = claimed.filter((id): id is string => typeof id === 'string');
  if (claimedIds.length === 0) {
    return false;
  }
  return !named.some((id) => claimedIds.includes(id));
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
  const injection = scanForInjection(message);
  const customerMessage = recordAgentMessage(ctx.db, {
    handoffId: active.id,
    sender: 'customer',
    body: message,
    now,
    injection,
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
  }, result.decision.refundItemIds);

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
