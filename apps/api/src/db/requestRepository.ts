import type { Db } from './connection.js';
import { appendAuditEvent } from './auditChain.js';
import { queryAll, queryOne } from './sql.js';
import { DECISIONS, type Decision } from '@refund/shared';
import { IncoherentDecisionError } from '../http/errors.js';
import { formatCents } from '../lib/money.js';
import type { AuditEventRecord, LlmCallRecord, PersistedRequest } from './records.js';

export interface NewRequestRow {
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly messageSha256: string;
  /**
   * The decision union rather than `string`, so the coherence check below is
   * applied to a value the compiler already knows is a decision - and so a typo
   * like `'denied '` is a type error rather than a stored row nobody can read.
   */
  readonly decision: Decision;
  readonly refundAmountCents: number;
  readonly eligibleAmountCents: number;
  readonly summary: string;
  readonly policyRef: string;
  readonly traceJson: string;
  readonly overridesJson: string;
  readonly eligibleItemIdsJson: string;
  readonly blockedItemsJson: string;
  readonly responseText: string;
  readonly extractionJson: string | null;
  readonly groundingJson: string | null;
  readonly injectionJson: string;
  readonly aiMode: string;
  readonly llmCalled: boolean;
  readonly timingsJson: string;
  readonly scenarioId: string | null;
}

const INSERT_SQL = `
INSERT INTO refund_requests (
  id, created_at, customer_id, order_id, message, message_sha256,
  decision, refund_amount_cents, eligible_amount_cents, summary, policy_ref,
  trace_json, overrides_json, eligible_item_ids_json, blocked_items_json,
  response_text, extraction_json, grounding_json, injection_json,
  ai_mode, llm_called, timings_json, scenario_id
) VALUES (
  @id, @createdAt, @customerId, @orderId, @message, @messageSha256,
  @decision, @refundAmountCents, @eligibleAmountCents, @summary, @policyRef,
  @traceJson, @overridesJson, @eligibleItemIdsJson, @blockedItemsJson,
  @responseText, @extractionJson, @groundingJson, @injectionJson,
  @aiMode, @llmCalled, @timingsJson, @scenarioId
)`;

export function insertRequest(db: Db, row: NewRequestRow): void {
  // Checked here as well as on the override path: this is where the resolver's
  // decision first reaches the database, so it is the last point at which an
  // incoherent pair can be refused instead of stored.
  assertDecisionCoherent(row.decision, row.refundAmountCents);
  db.prepare(INSERT_SQL).run({ ...row, llmCalled: row.llmCalled ? 1 : 0 });
}

const SELECT_COLUMNS = `
  id, created_at, customer_id, order_id, message, message_sha256,
  decision, refund_amount_cents, eligible_amount_cents, summary, policy_ref,
  trace_json, overrides_json, eligible_item_ids_json, blocked_items_json,
  response_text, extraction_json, grounding_json, injection_json,
  ai_mode, llm_called, timings_json, overridden_by, override_note, scenario_id,
  (SELECT name FROM customers WHERE customers.id = refund_requests.customer_id) AS customer_name
`;

/** SQLite returns snake_case columns; `PersistedRequest` is camelCase. */
interface RequestRow {
  readonly id: string;
  readonly created_at: string;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly order_id: string | null;
  readonly message: string;
  readonly message_sha256: string;
  readonly decision: string;
  readonly refund_amount_cents: number;
  readonly eligible_amount_cents: number;
  readonly summary: string;
  readonly policy_ref: string;
  readonly trace_json: string;
  readonly overrides_json: string;
  readonly eligible_item_ids_json: string;
  readonly blocked_items_json: string;
  readonly response_text: string;
  readonly extraction_json: string | null;
  readonly grounding_json: string | null;
  readonly injection_json: string;
  readonly ai_mode: string;
  readonly llm_called: number;
  readonly timings_json: string;
  readonly overridden_by: string | null;
  readonly override_note: string | null;
  readonly scenario_id: string | null;
}

function hydrate(row: RequestRow): PersistedRequest {
  return {
    id: row.id,
    createdAt: row.created_at,
    customerId: row.customer_id,
    customerName: row.customer_name,
    orderId: row.order_id,
    message: row.message,
    decision: toDecision(row.decision),
    refundAmountCents: row.refund_amount_cents,
    eligibleAmountCents: row.eligible_amount_cents,
    summary: row.summary,
    policyRef: row.policy_ref,
    traceJson: row.trace_json,
    overridesJson: row.overrides_json,
    eligibleItemIdsJson: row.eligible_item_ids_json,
    blockedItemsJson: row.blocked_items_json,
    responseText: row.response_text,
    extractionJson: row.extraction_json,
    groundingJson: row.grounding_json,
    injectionJson: row.injection_json,
    aiMode: row.ai_mode,
    llmCalled: row.llm_called,
    timingsJson: row.timings_json,
    overriddenBy: row.overridden_by,
    overrideNote: row.override_note,
    scenarioId: row.scenario_id,
  };
}

export function findRequestById(db: Db, id: string): PersistedRequest | null {
  const row = queryOne<RequestRow>(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM refund_requests WHERE id = ?`),
    id,
  );
  return row === null ? null : hydrate(row);
}

export interface ListFilter {
  readonly decision?: string | undefined;
  readonly customerId?: string | undefined;
  readonly search?: string | undefined;
  readonly limit: number;
}

export function listRequests(db: Db, filter: ListFilter): PersistedRequest[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.decision !== undefined) {
    clauses.push('decision = ?');
    params.push(filter.decision);
  }
  if (filter.customerId !== undefined) {
    clauses.push('customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.search !== undefined && filter.search.length > 0) {
    clauses.push('(message LIKE ? OR id LIKE ? OR order_id LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like, like);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = queryAll<RequestRow>(
    db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM refund_requests ${where} ORDER BY created_at DESC LIMIT ?`,
    ),
    ...params,
    filter.limit,
  );
  return rows.map(hydrate);
}

/**
 * Records a human decision in place of the resolver's.
 *
 * The amount is rewritten from the decision, never left as it was. The resolver
 * already guarantees that a denial carries no payable amount
 * (`amountFor()` in policy/resolver.ts); an override that changed only the
 * decision could leave a *denied* request holding a live amount, which is
 * precisely the state a payout process must never see. Re-deriving here keeps
 * that invariant true for every writer, including this one.
 *
 * `refund_requests` remains a mutable read model - the authoritative,
 * tamper-evident history is `audit_events` (see db/auditChain.ts).
 */
export function applyHumanOverride(
  db: Db,
  id: string,
  decision: Decision,
  agentId: string,
  note: string,
  eligibleAmountCents: number,
): void {
  // Only an approval may carry money, so anything else is written as $0 - an
  // override that merely changed the decision must not leave the old amount
  // live on the row.
  const amount = decision === 'approved' ? eligibleAmountCents : 0;
  assertDecisionCoherent(decision, amount);
  db.prepare(
    `UPDATE refund_requests
        SET decision = ?, refund_amount_cents = ?, overridden_by = ?, override_note = ?
      WHERE id = ?`,
  ).run(decision, amount, agentId, note, id);
}

/**
 * Money safety, stated once: money is authorised only by an approval.
 *
 * Enforced before every write that can set either field, so a bad pair is refused
 * rather than recorded. It runs *before* the statement on purpose - asserted
 * after, a thrown error would leave the incoherent row already committed, which
 * is the exact state the check exists to prevent.
 */
export function assertDecisionCoherent(decision: Decision, amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new IncoherentDecisionError(
      `a refund amount must be a non-negative whole number of cents (got ${amountCents})`,
    );
  }
  if (decision === 'approved' && amountCents <= 0) {
    throw new IncoherentDecisionError(
      amountCents === 0
        ? 'nothing on this order is eligible for refund, so it cannot be approved. Check the blocked items in the decision trace.'
        : 'an approved request must carry a positive amount',
    );
  }
  if (decision !== 'approved' && amountCents !== 0) {
    // The mirror of the rule above, and the one a payout job would trip over: a
    // `denied` or `escalated` request holding a live amount reads as money that
    // may leave the till, on a decision nobody authorised.
    throw new IncoherentDecisionError(
      `a ${decision} request cannot carry a payable amount (got ${formatCents(amountCents)}); ` +
        'the figure under review belongs in eligible_amount_cents',
    );
  }
}

/**
 * The one way an audit event is written.
 *
 * Delegates rather than running its own INSERT so that adding a hash to the trail
 * cannot be done for one call site and forgotten for another - a chained column
 * that is null on a few rows is a trail that fails verification and a support
 * ticket nobody can explain.
 */
export function insertAuditEvent(
  db: Db,
  requestId: string,
  at: string,
  kind: string,
  detail: string,
): void {
  appendAuditEvent(db, { requestId, at, kind, detail });
}

/**
 * Validates a decision read from the database.
 *
 * The column is TEXT, so it can hold anything a migration, a manual fix, or a
 * bug left behind. It is checked rather than cast: a row whose decision cannot be
 * understood must fail loudly at the boundary, not flow into a resolver or a
 * payout job as a value nobody can act on.
 */
function toDecision(value: string): Decision {
  if ((DECISIONS as readonly string[]).includes(value)) {
    return value as Decision;
  }
  throw new Error(`refund_requests.decision holds "${value}", which is not one of ${DECISIONS.join(', ')}`);
}

/** `SELECT *` returns snake_case; these records are declared in camelCase. */
interface AuditRow {
  readonly id: number;
  readonly request_id: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

function hydrateAudit(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    at: row.at,
    kind: row.kind,
    detail: row.detail,
  };
}

export function listAuditEvents(db: Db, requestId: string): AuditEventRecord[] {
  return queryAll<AuditRow>(
    db.prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY id'),
    requestId,
  ).map(hydrateAudit);
}

export function insertLlmCall(
  db: Db,
  call: Omit<LlmCallRecord, 'id' | 'ok'> & { readonly ok: boolean },
): void {
  db.prepare(
    `INSERT INTO llm_calls
       (request_id, at, purpose, provider, model, attempt, ok, latency_ms,
        prompt_tokens, completion_tokens, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.requestId,
    call.at,
    call.purpose,
    call.provider,
    call.model,
    call.attempt,
    call.ok ? 1 : 0,
    call.latencyMs,
    call.promptTokens,
    call.completionTokens,
    call.error,
  );
}
