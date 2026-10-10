import { randomUUID } from 'node:crypto';
import { AWAITING_AGENT_ID, type InjectionScan, type InjectionSignal } from '@refund/shared';
import type { Db } from './connection.js';
import { queryAll } from './sql.js';
import { openAppealsForCustomer, type Appeal } from './appeals.js';
import { findRequestById, latestRequestForThread } from './requestRepository.js';

/**
 * Live human takeover of a customer thread.
 *
 * The assistant and the customer talk through `shop_dialogue`; when a person
 * takes over, the thread keeps going but the pipeline is bypassed. The two rows
 * this module owns are the takeover itself (`handoffs`) and the words exchanged
 * while it is live (`agent_messages`), because `shop_dialogue` is a strict
 * question-and-answer shape and a free conversation does not fit it.
 *
 * Two rules are worth stating because both are safety properties:
 *
 *  - A customer has at most one live takeover *per escalated order*, and at most
 *    one customer-wide takeover for the no-order and whole-thread cases. That is
 *    enforced by partial unique indexes in the migration *and* checked in
 *    `startHandoff`, because a constraint someone has to read the schema to find
 *    is not a guard. The per-order carve-out is what lets two escalations on
 *    different orders both reach a person instead of the second being silently
 *    dropped.
 *  - The customer's messages during a takeover are stored here, not run through
 *    the pipeline. The pipeline's output is a decision; while a person is on the
 *    line, the person is the decision maker, and the fewer decisions the
 *    pipeline has produced the less there is to untangle afterwards.
 */

/** Bound for every live-handoff scan below: a lookup runs per chat message. */
const MAX_LIVE_HANDOFFS = 10;

/**
 * The `agent_id` of a takeover nobody has claimed yet.
 *
 * A distinct sentinel rather than null, because "waiting for a person" and "a
 * person is typing" are different things for the staff console to show and
 * different things for the customer to be told. Everything downstream already
 * keys on the presence of a handoff; only this id says the conversation is
 * unattended.
 */
export const ESCALATION_AGENT = AWAITING_AGENT_ID;

export interface ActiveHandoff {
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly agentId: string;
  readonly startedAt: string;
  /**
   * True while the takeover is still the automatic escalation marker and no
   * person has claimed it. The staff console keys its verbs on this rather than
   * on `agentId`, so "waiting for a person" does not render as "a colleague has
   * taken over" and offer a reply box that the message route then refuses.
   */
  readonly unattended: boolean;
  /**
   * Which decided escalation this takeover is the human side of, if any. Null
   * means the takeover predates forks or a person took over on their own
   * initiative — no decided case behind it, so no item scope to enforce and
   * the takeover keeps the old whole-thread reach rather than gaining a scope
   * nobody recorded.
   */
  readonly requestId: string | null;
}

/**
 * The slice of a customer's history a forked takeover speaks for.
 *
 * A fork answers only for the escalated case it was forked from — its order
 * and the claim's item ids — while everything else the customer says keeps
 * flowing through the pipeline. That is the whole point of the fork: one
 * escalation can no longer swallow the customer's other items.
 */
export interface ForkScope {
  readonly orderId: string;
  readonly itemIds: readonly string[];
}

export interface AgentMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly handoffId: string;
  readonly sender: 'agent' | 'customer';
  readonly body: string;
  /**
   * The policy-override scan of the message's text, recorded so the staff
   * thread keeps the same evidence trail a decided case keeps. Agent messages
   * carry an empty scan: the person on the line is the trusted side of the
   * exchange.
   */
  readonly injection: InjectionScan;
}

interface HandoffRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly agent_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly request_id: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly created_at: string;
  readonly handoff_id: string;
  readonly sender: string;
  readonly body: string;
  readonly injection_detected: number;
  readonly injection_signals: string | null;
}

export class HandoffAlreadyActiveError extends Error {
  constructor(customerId: string) {
    super(`customer ${customerId} already has a live takeover`);
    this.name = 'HandoffAlreadyActiveError';
  }
}

export class NoActiveHandoffError extends Error {
  constructor(customerId: string) {
    super(`customer ${customerId} has no live takeover to message or end`);
    this.name = 'NoActiveHandoffError';
  }
}

export function activeHandoffForCustomer(db: Db, customerId: string): ActiveHandoff | null {
  const row = db
    .prepare('SELECT * FROM handoffs WHERE customer_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get(customerId) as HandoffRow | undefined;
  return row === undefined ? null : toActive(row);
}

/** Every live takeover for the customer, newest first, bounded. */
export function liveHandoffsForCustomer(db: Db, customerId: string): readonly ActiveHandoff[] {
  const rows = db
    .prepare('SELECT * FROM handoffs WHERE customer_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT ?')
    .all(customerId, MAX_LIVE_HANDOFFS) as HandoffRow[];
  return rows.map(toActive);
}

/**
 * The live takeover that currently speaks for this thread, if any.
 *
 * With forks, "the thread that changed hands" is narrower than the customer:
 * a fork exists because one order escalated, and it answers only for that
 * order. Older takeovers - a person on the line before forks were scoped, or
 * a handoff with no order recorded because the customer was mid-clarify -
 * kept the whole-thread reach and thus cover every thread. Newest covering
 * takeover wins, so a claimed fork reads as the current owner of its own
 * order even when an older unattended marker for a different order is still
 * waiting.
 */
export function liveHandoffForThread(db: Db, customerId: string, orderId: string | null): ActiveHandoff | null {
  for (const live of liveHandoffsForCustomer(db, customerId)) {
    if (isThreadOf(db, live, orderId)) {
      return live;
    }
  }
  return null;
}

export interface StartHandoffInput {
  readonly customerId: string;
  readonly orderId: string | null;
  readonly agentId: string;
  readonly now: Date;
  /**
   * The decided escalation this takeover is the human side of. Pass null for
   * a staff-initiated takeover with no decided case behind it — the new
   * takeover then keeps the old whole-thread reach rather than gaining a
   * scope nobody recorded. Required so each creation site states its fork
   * binding explicitly instead of silently inheriting one.
   */
  readonly requestId: string | null;
}

export function startHandoff(db: Db, input: StartHandoffInput): ActiveHandoff {
  for (const live of liveHandoffsForCustomer(db, input.customerId)) {
    if (takeoversClash(live, input)) {
      throw new HandoffAlreadyActiveError(input.customerId);
    }
  }
  const handoff: ActiveHandoff = {
    id: `HAND-${randomUUID()}`,
    customerId: input.customerId,
    orderId: input.orderId,
    agentId: input.agentId,
    startedAt: input.now.toISOString(),
    unattended: input.agentId === ESCALATION_AGENT,
    requestId: input.requestId,
  };
  db.prepare(
    `INSERT INTO handoffs (id, customer_id, order_id, agent_id, started_at, ended_at, request_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(handoff.id, handoff.customerId, handoff.orderId, handoff.agentId, handoff.startedAt, handoff.requestId);
  return handoff;
}

/**
 * Whether a new takeover may not open beside a live one.
 *
 * A fork speaks for the escalated case it was forked from, so forks on
 * different orders coexist - that is exactly what lets two escalations for one
 * customer both reach a person instead of the second being dropped. Everything
 * broader does not compound: a whole-customer takeover (no order yet) and a
 * whole-thread takeover (no decided case behind it) each own whatever the
 * customer says next, so either blocks any new takeover, on any order.
 */
function takeoversClash(live: ActiveHandoff, input: StartHandoffInput): boolean {
  if (live.orderId === null || input.orderId === null) {
    return true;
  }
  if (live.requestId === null && input.requestId === null) {
    return live.orderId === input.orderId;
  }
  if (live.orderId === input.orderId && (live.requestId === null || input.requestId === null)) {
    return true;
  }
  return false;
}

/**
 * The takeover an escalated thread should be talking to, real or automatic.
 *
 * This is where the persona switch lives. A human takeover is the obvious
 * trigger, but escalation is the *decision*: once a thread has been escalated
 * there is nothing left for the pipeline to compute, so running it again on the
 * next message either re-decides a case already with a person or re-runs a model
 * on a thread nobody is waiting on. Auto-provisioning a takeover for an escalated
 * thread makes the escalated state the single trigger - a person taking over just
 * fills in `agentId`.
 *
 * The escalation is *open* only until someone acts. A takeover on the thread
 * that has since ended is the marker that a person looked at this case, which is
 * what clears it: without that check the automatic takeover would reappear the
 * moment a person handed the thread back, and hand-back would be a button that
 * silently does nothing.
 */
export function takeoverForEscalated(
  db: Db,
  customerId: string,
  orderId: string | null,
  now: Date,
): ActiveHandoff | null {
  // A live takeover that already covers this thread satisfies the escalation:
  // its own forked case, or a whole-thread person attached to the customer.
  const covering = liveHandoffForThread(db, customerId, orderId);
  if (covering !== null) {
    return covering;
  }

  const latest = latestRequestForThread(db, customerId, orderId);
  if (latest === null || latest.decision !== 'escalated') {
    return null;
  }
  if (escalationWasHandled(db, customerId, latest.orderId, latest.createdAt)) {
    return null;
  }
  try {
    // Fork binding: this takeover is the human side of this exact decided
    // escalation, so only its own case's follow-ups route here. Anything else
    // the customer says keeps flowing through the pipeline. A second escalation
    // on a different order from the same customer is not "anything else" - it is
    // its own case with no human side yet, so it raises its own takeover rather
    // than being dropped where the old customer-wide lock dropped it.
    return startHandoff(db, {
      customerId,
      orderId: latest.orderId,
      agentId: ESCALATION_AGENT,
      now,
      requestId: latest.id,
    });
  } catch (error) {
    // Another process may have opened a takeover after the read above. If the
    // winner covers this thread the escalation is handled; if it reaches only
    // another order, this thread keeps its escalation visible in the queue and a
    // follow-up touching it will raise its own takeover there and then.
    if (error instanceof HandoffAlreadyActiveError) {
      return liveHandoffForThread(db, customerId, orderId);
    }
    throw error;
  }
}

/**
 * Whether a takeover belongs to the thread being messaged.
 *
 * A takeover row exists for two reasons now, and they do not have the same
 * reach. A *person* attached to the customer before forks were scoped took
 * whatever they next talked about, so a pre-fork takeover (and a handoff with
 * no order recorded) is still customer-wide on purpose. A *forked* takeover is
 * the human side of one escalated case: it answers for that case's order and
 * items, and letting it swallow another order's thread would move a complaint
 * nobody has looked at onto a case file for a different order - quietly denying
 * a refund claim by burying it, which is worse than the escalation it replaced.
 */
function isThreadOf(_db: Db, handoff: ActiveHandoff, orderId: string | null): boolean {
  if (handoff.orderId === null) {
    return true;
  }
  return handoff.orderId === orderId;
}

/** Whether a takeover on this thread opened and closed after the escalation. */
function escalationWasHandled(db: Db, customerId: string, orderId: string | null, escalatedAt: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS handled FROM handoffs
        WHERE customer_id = ? AND order_id IS ? AND ended_at IS NOT NULL AND ended_at >= ?
        LIMIT 1`,
    )
    .get(customerId, orderId, escalatedAt);
  return row !== undefined;
}

/**
 * A person claims the unattended takeover on one thread.
 *
 * The auto-provisioned escalation takeover must not lock a person out of the
 * thread it exists to get them to: `startHandoff` refuses a second takeover on
 * the same order, so without this the customer who escalated automatically
 * could never be helped by a human. Scoped by order, because two escalations on
 * two orders now mean two live markers - claiming the customer must not grab
 * the sibling order's case along with this one. Returns the takeover now owned
 * by `agentId`, or null when this thread's live one is already a person's -
 * which is the race, and stays a race.
 */
export function claimUnattendedHandoff(
  db: Db,
  customerId: string,
  orderId: string | null,
  agentId: string,
): ActiveHandoff | null {
  // The sentinel lives in the WHERE clause rather than in a read above it. Two
  // staff members claiming the same escalated thread is the same race
  // `startHandoff` refuses, and a read-then-write would let both of them see
  // `awaiting-agent` and both walk away believing they own it.
  const claimed = db
    .prepare(
      `UPDATE handoffs SET agent_id = ?
        WHERE customer_id = ? AND order_id IS ? AND ended_at IS NULL AND agent_id = ?
        RETURNING id, customer_id, order_id, agent_id, started_at`,
    )
    .get(agentId, customerId, orderId, ESCALATION_AGENT) as HandoffRow | undefined;
  return claimed === undefined ? null : toActive(claimed);
}

/** Ends the live takeover on one order, returning what it was, or null. */
export function endHandoff(db: Db, customerId: string, orderId: string | null, now: Date): ActiveHandoff | null {
  const row = db
    .prepare(
      'SELECT * FROM handoffs WHERE customer_id = ? AND order_id IS ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    )
    .get(customerId, orderId) as HandoffRow | undefined;
  if (row === undefined) {
    return null;
  }
  const active = toActive(row);
  db.prepare('UPDATE handoffs SET ended_at = ? WHERE id = ?').run(now.toISOString(), active.id);
  return active;
}

export interface RecordMessageInput {
  readonly handoffId: string;
  readonly sender: 'agent' | 'customer';
  readonly body: string;
  readonly now: Date;
  readonly injection: InjectionScan;
}

export function recordAgentMessage(db: Db, input: RecordMessageInput): AgentMessage {
  const message: AgentMessage = {
    id: `MSG-${randomUUID()}`,
    createdAt: input.now.toISOString(),
    handoffId: input.handoffId,
    sender: input.sender,
    body: input.body,
    injection: input.injection,
  };
  db.prepare(
    `INSERT INTO agent_messages (id, created_at, handoff_id, sender, body, injection_detected, injection_signals)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.createdAt,
    message.handoffId,
    message.sender,
    message.body,
    message.injection.detected ? '1' : '0',
    JSON.stringify(message.injection.signals),
  );
  return message;
}

/**
 * Every message exchanged with a person on a given thread, oldest first.
 *
 * Scoped by customer as well as order, exactly like the request history beside
 * it: either condition is sufficient, and a filter that is the only defence is
 * one refactor away from not being one. `order_id` is matched with `IS` so the
 * mid-clarify case (no order yet) joins on NULL correctly.
 */
export function listAgentMessagesForOrder(
  db: Db,
  customerId: string,
  orderId: string | null,
  limit: number,
): readonly AgentMessage[] {
  const rows = queryAll<MessageRow>(
    db.prepare(
      `SELECT m.id, m.created_at, m.handoff_id, m.sender, m.body, m.injection_detected, m.injection_signals
         FROM agent_messages m
         JOIN handoffs h ON h.id = m.handoff_id
        WHERE h.customer_id = ? AND h.order_id IS ?
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    limit,
  );
  return rows.map(hydrateMessage).reverse();
}

/**
 * One takeover by id, or null. The fork endpoints key on this rather than the
 * customer-scoped live lookup: a customer can hold one live takeover while
 * reading another fork's history, and the live lookup would answer about the
 * wrong one.
 */
export function handoffById(db: Db, handoffId: string): ActiveHandoff | null {
  const row = db.prepare('SELECT * FROM handoffs WHERE id = ?').get(handoffId) as HandoffRow | undefined;
  return row === undefined ? null : toActive(row);
}

/**
 * The newest takeover on a thread, live or ended.
 *
 * Parked follow-ups journal here so the agent who picks the case up reads the
 * whole conversation, including what arrived while nobody held it. Live first
 * is wrong for this: a handoff that was taken and handed back is still the
 * thread's human side, and a follow-up filed onto a fresh marker instead
 * would split one conversation across two threads.
 */
export function latestHandoffForThread(
  db: Db,
  customerId: string,
  orderId: string | null,
): ActiveHandoff | null {
  const row = db.prepare(
    `SELECT * FROM handoffs WHERE customer_id = ? AND order_id IS ?
     ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(customerId, orderId) as HandoffRow | undefined;
  return row === undefined ? null : toActive(row);
}

/** Every message on one takeover, oldest first, bounded for the side panel. */
export function messagesForHandoff(db: Db, handoffId: string, limit: number): readonly AgentMessage[] {
  const rows = queryAll<MessageRow>(
    db.prepare(
      `SELECT id, created_at, handoff_id, sender, body, injection_detected, injection_signals FROM agent_messages
        WHERE handoff_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ),
    handoffId,
    limit,
  );
  return rows.map(hydrateMessage).reverse();
}

export interface ConversationCandidate {
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly lastActivityAt: string;
  readonly activityCount: number;
  readonly   activeHandoff: ActiveHandoff | null;
  /**
   * The item slice the live takeover speaks for, for the queue's case line.
   * Null when there is no live takeover or it predates forks — the queue
   * then shows the thread as before, with no case boundary to name.
   */
  readonly forkScope: ForkScope | null;
  /** Refusals the customer is asking a person to look at again, oldest first. */
  readonly openAppeals: readonly Appeal[];
}

/**
 * The threads a staff member might want to pick up, most active last.
 *
 * Built from a UNION over everything that touches a thread - requests, dialogue,
 * updates and agent messages - so a conversation is on the list whether or not
 * it ever produced a decision row. The active handoff is attached per thread,
 * because with forks a takeover belongs to the order it was forked from; a
 * claim or a notice must not light up the customer's other rows.
 */
export function listConversationCandidates(
  db: Db,
  since: string,
  limit: number,
): readonly ConversationCandidate[] {
  const rows = queryAll<{
    customer_id: string;
    order_id: string | null;
    last_activity: string;
    activity: number;
  }>(
    db.prepare(
      `SELECT customer_id, order_id, MAX(at) AS last_activity, COUNT(*) AS activity
         FROM (
           SELECT customer_id, order_id, created_at AS at FROM refund_requests
           UNION ALL SELECT customer_id, order_id, created_at FROM shop_dialogue
           UNION ALL SELECT customer_id, order_id, created_at FROM customer_updates
           UNION ALL SELECT h.customer_id, h.order_id, m.created_at
             FROM agent_messages m JOIN handoffs h ON h.id = m.handoff_id
         )
        GROUP BY customer_id, order_id
       HAVING MAX(at) >= ?
       ORDER BY last_activity DESC
       LIMIT ?`,
    ),
    since,
    limit,
  );

  return rows.map((row) => {
    const nameRow = db
      .prepare('SELECT name FROM customers WHERE id = ?')
      .get(row.customer_id) as { name: string } | undefined;
    const active = liveHandoffForThread(db, row.customer_id, row.order_id);
    return {
      customerId: row.customer_id,
      customerName: nameRow?.name ?? 'Unknown customer',
      orderId: row.order_id,
      lastActivityAt: row.last_activity,
      activityCount: row.activity,
      activeHandoff: active,
      forkScope: active === null ? null : forkScopeForHandoff(db, active),
      openAppeals: openAppealsForCustomer(db, row.customer_id),
    }; 
  });
}

function toActive(row: HandoffRow): ActiveHandoff {
  return {
    id: row.id,
    customerId: row.customer_id,
    orderId: row.order_id,
    agentId: row.agent_id,
    startedAt: row.started_at,
    unattended: row.agent_id === ESCALATION_AGENT,
    requestId: row.request_id,
  };
}

function hydrateMessage(row: MessageRow): AgentMessage {
  let signals: readonly InjectionSignal[] = [];
  if (row.injection_signals !== null && row.injection_signals.length > 0) {
    try {
      signals = JSON.parse(row.injection_signals) as InjectionSignal[];
    } catch {
      signals = [];
    }
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    handoffId: row.handoff_id,
    sender: row.sender as AgentMessage['sender'],
    body: row.body,
    injection: {
      detected: row.injection_detected === 1,
      signals,
      // The staff thread is an evidence trail, not a decision record: the
      // obfuscation note only says "and also this looked squiggly", and the
      // scan response to it was recorded at decision time, so a live read of
      // history does not re-decide it.
      obfuscationNoted: false,
    },
  };
}

/**
 * Bounds for every fork loop below (Rule 2): a fork lookup runs once per chat
 * message, so each scan carries its cap in its header or its query.
 */
const MAX_FORK_SCOPE_IDS = 64;

/** A live person-claimed takeover together with the slice it speaks for. */
export interface ClaimedFork {
  readonly handoff: ActiveHandoff;
  /** Null for pre-fork takeovers: no decided case behind them, whole-thread reach. */
  readonly scope: ForkScope | null;
}

/**
 * Which fork a new customer message belongs to, if any.
 *
 * First fork whose scope contains the message's thread wins, newest first: the
 * fork answers its own case's follow-ups, so "no, refund the lamps too" after
 * an escalated sofa lands with the person on the sofa. Anything else — a
 * different order, a message naming only unclaimed items, no resolution at
 * all — falls through to the pipeline and starts its own case. An unscoped
 * legacy takeover is deliberately skipped here: it speaks for the whole
 * thread and keeps going through the existing whole-thread divert.
 */
export function forkForMessage(
  db: Db,
  customerId: string,
  thread: { orderId: string | null; itemIds: readonly string[] },
): ClaimedFork | null {
  if (thread.orderId === null) {
    return null;
  }
  for (const fork of liveClaimedForks(db, customerId)) {
    if (fork.scope !== null && forkMatchesThread(fork.scope, thread.orderId, thread.itemIds)) {
      return fork;
    }
  }
  return null;
}

/** The customer's live person-claimed takeovers — the forks — newest first. */
export function liveClaimedForks(db: Db, customerId: string): readonly ClaimedFork[] {
  const rows = db
    .prepare(
      `SELECT * FROM handoffs
       WHERE customer_id = ? AND ended_at IS NULL AND agent_id <> ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(customerId, ESCALATION_AGENT, MAX_LIVE_HANDOFFS) as HandoffRow[];
  return rows.map((row) => {
    const handoff = toActive(row);
    return { handoff, scope: forkScopeForHandoff(db, handoff) };
  });
}

/**
 * The item slice a fork speaks for, from the escalated case it was forked
 * from. Prefers the decided claim, falls back to the eligible items (a case
 * can escalate with an empty claim when extraction found nothing to pay);
 * empty either way means no recorded scope, so the takeover keeps the old
 * whole-thread reach rather than enforcing a boundary nobody stored.
 */
export function forkScopeForHandoff(db: Db, handoff: ActiveHandoff): ForkScope | null {
  if (handoff.requestId === null) {
    return null;
  }
  const request = findRequestById(db, handoff.requestId);
  if (request === null || request.orderId === null) {
    return null;
  }
  const claimed = parseScopeIds(request.claimItemIdsJson);
  const ids = claimed.length > 0 ? claimed : parseScopeIds(request.eligibleItemIdsJson);
  if (ids.length === 0) {
    return null;
  }
  return { orderId: request.orderId, itemIds: ids };
}

function forkMatchesThread(scope: ForkScope, orderId: string, itemIds: readonly string[]): boolean {
  if (scope.orderId !== orderId) {
    return false;
  }
  if (itemIds.length === 0) {
    return true;
  }
  return itemIds.some((id) => scope.itemIds.includes(id));
}

function parseScopeIds(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const ids: string[] = [];
  for (let i = 0; i < Math.min(parsed.length, MAX_FORK_SCOPE_IDS); i++) {
    const entry: unknown = parsed[i];
    if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry);
    }
  }
  return ids;
}