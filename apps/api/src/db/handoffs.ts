import { randomUUID } from 'node:crypto';
import type { Db } from './connection.js';
import { queryAll } from './sql.js';
import { openAppealsForCustomer, type Appeal } from './appeals.js';
import { latestRequestForThread } from './requestRepository.js';

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
 *  - A customer has at most one live takeover. That is enforced by a partial
 *    unique index in the migration *and* checked in `startHandoff`, because a
 *    constraint someone has to read the schema to find is not a guard.
 *  - The customer's messages during a takeover are stored here, not run through
 *    the pipeline. The pipeline's output is a decision; while a person is on the
 *    line, the person is the decision maker, and the fewer decisions the
 *    pipeline has produced the less there is to untangle afterwards.
 */

 /** Shown in the thread from the moment a person takes over until they hand back. */
export const HANDSOFF_NOTICE = 'Connecting you to a customer agent - please hold.';

/**
 * The `agent_id` of a takeover nobody has claimed yet.
 *
 * A distinct sentinel rather than null, because "waiting for a person" and "a
 * person is typing" are different things for the staff console to show and
 * different things for the customer to be told. Everything downstream already
 * keys on the presence of a handoff; only this id says the conversation is
 * unattended.
 */
export const ESCALATION_AGENT = 'awaiting-agent';

export interface ActiveHandoff {
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly agentId: string;
  readonly startedAt: string;
}

export interface AgentMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly handoffId: string;
  readonly sender: 'agent' | 'customer';
  readonly body: string;
}

interface HandoffRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_id: string | null;
  readonly agent_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly created_at: string;
  readonly handoff_id: string;
  readonly sender: string;
  readonly body: string;
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

export interface StartHandoffInput {
  readonly customerId: string;
  readonly orderId: string | null;
  readonly agentId: string;
  readonly now: Date;
}

export function startHandoff(db: Db, input: StartHandoffInput): ActiveHandoff {
  if (activeHandoffForCustomer(db, input.customerId) !== null) {
    throw new HandoffAlreadyActiveError(input.customerId);
  }
  const handoff: ActiveHandoff = {
    id: `HAND-${randomUUID()}`,
    customerId: input.customerId,
    orderId: input.orderId,
    agentId: input.agentId,
    startedAt: input.now.toISOString(),
  };
  db.prepare(
    `INSERT INTO handoffs (id, customer_id, order_id, agent_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(handoff.id, handoff.customerId, handoff.orderId, handoff.agentId, handoff.startedAt);
  return handoff;
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
  const live = activeHandoffForCustomer(db, customerId);
  if (live !== null) {
    return live;
  }

  const latest = latestRequestForThread(db, customerId, orderId);
  if (latest === null || latest.decision !== 'escalated') {
    return null;
  }
  if (escalationWasHandled(db, customerId, latest.orderId, latest.createdAt)) {
    return null;
  }
  return startHandoff(db, { customerId, orderId: latest.orderId, agentId: ESCALATION_AGENT, now });
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

/** Ends the customer's live takeover, returning what it was, or null. */
export function endHandoff(db: Db, customerId: string, now: Date): ActiveHandoff | null {
  const active = activeHandoffForCustomer(db, customerId);
  if (active === null) {
    return null;
  }
  db.prepare('UPDATE handoffs SET ended_at = ? WHERE id = ?').run(now.toISOString(), active.id);
  return active;
}

export interface RecordMessageInput {
  readonly handoffId: string;
  readonly sender: 'agent' | 'customer';
  readonly body: string;
  readonly now: Date;
}

export function recordAgentMessage(db: Db, input: RecordMessageInput): AgentMessage {
  const message: AgentMessage = {
    id: `MSG-${randomUUID()}`,
    createdAt: input.now.toISOString(),
    handoffId: input.handoffId,
    sender: input.sender,
    body: input.body,
  };
  db.prepare(
    `INSERT INTO agent_messages (id, created_at, handoff_id, sender, body)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(message.id, message.createdAt, message.handoffId, message.sender, message.body);
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
      `SELECT m.id, m.created_at, m.handoff_id, m.sender, m.body
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

export interface ConversationCandidate {
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly lastActivityAt: string;
  readonly activityCount: number;
  readonly activeHandoff: ActiveHandoff | null;
  /** Refusals the customer is asking a person to look at again, oldest first. */
  readonly openAppeals: readonly Appeal[];
}

/**
 * The threads a staff member might want to pick up, most active last.
 *
 * Built from a UNION over everything that touches a thread - requests, dialogue,
 * updates and agent messages - so a conversation is on the list whether or not
 * it ever produced a decision row. The active handoff is attached per customer,
 * because a takeover is per customer no matter which order the thread drifted to.
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
    return {
      customerId: row.customer_id,
      customerName: nameRow?.name ?? 'Unknown customer',
      orderId: row.order_id,
      lastActivityAt: row.last_activity,
      activityCount: row.activity,
      activeHandoff: activeHandoffForCustomer(db, row.customer_id),
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
  };
}

function hydrateMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    createdAt: row.created_at,
    handoffId: row.handoff_id,
    sender: row.sender as AgentMessage['sender'],
    body: row.body,
  };
}