import { createHash } from 'node:crypto';
import type { Db } from './connection.js';
import { appendAuditEvent } from './auditChain.js';
import { queryAll, queryOne } from './sql.js';
import { DECISIONS, MONEY_DECISIONS, type Decision } from '@refund/shared';
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
   * Normalised-message hash. Derived from `message` here rather than accepted
   * from the caller, because a caller-supplied fingerprint is a caller-supplied
   * duplicate check - two requests could be made to collide on purpose by
   * passing the same value, which is the exact case the check exists to catch.
   */
  readonly messageFingerprint: string;
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
  readonly claimItemIdsJson?: string;
  readonly blockedItemsJson: string;
  readonly responseText: string;
  /**
   * What the ladder had to do, or null when it had to do nothing.
   *
   * Optional rather than nullable-and-required: a row written by a caller that never
   * heard of intake still has a truthful answer - there was no ladder step - and the
   * column defaults to NULL for exactly that reason.
   */
  readonly ingestNotice?: string | null | undefined;
  readonly extractionJson: string | null;
  readonly groundingJson: string | null;
  readonly injectionJson: string;
  readonly aiMode: string;
  readonly llmCalled: boolean;
  readonly timingsJson: string;
  readonly scenarioId: string | null;
  /**
   * Agent-facing case summary written by the model. Null when the model was
   * unavailable or the summary failed validation. Never a decision input.
   */
  readonly caseSummary?: string | null | undefined;
}

const INSERT_SQL = `
INSERT INTO refund_requests (
  id, created_at, customer_id, order_id, message, message_sha256, message_fingerprint,
  decision, refund_amount_cents, eligible_amount_cents, summary, policy_ref,
  trace_json, overrides_json, eligible_item_ids_json, claim_item_ids_json, blocked_items_json,
  response_text, ingest_notice, extraction_json, grounding_json, injection_json,
  ai_mode, llm_called, timings_json, scenario_id, case_summary
) VALUES (
  @id, @createdAt, @customerId, @orderId, @message, @messageSha256, @messageFingerprint,
  @decision, @refundAmountCents, @eligibleAmountCents, @summary, @policyRef,
  @traceJson, @overridesJson, @eligibleItemIdsJson, @claimItemIdsJson, @blockedItemsJson,
  @responseText, @ingestNotice, @extractionJson, @groundingJson, @injectionJson,
  @aiMode, @llmCalled, @timingsJson, @scenarioId, @caseSummary
)`;

export function insertRequest(db: Db, row: NewRequestRow): void {
  // Checked here as well as on the override path: this is where the resolver's
  // decision first reaches the database, so it is the last point at which an
  // incoherent pair can be refused instead of stored.
  assertDecisionCoherent(row.decision, row.refundAmountCents);
  db.prepare(INSERT_SQL).run({
    ...row,
    ingestNotice: row.ingestNotice ?? null,
    claimItemIdsJson: row.claimItemIdsJson ?? '[]',
    llmCalled: row.llmCalled ? 1 : 0,
    caseSummary: row.caseSummary ?? null,
  });
}

const SELECT_COLUMNS = `
  id, created_at, customer_id, order_id, message, message_sha256,
  decision, refund_amount_cents, eligible_amount_cents, summary, policy_ref,
  trace_json, overrides_json, eligible_item_ids_json, claim_item_ids_json, blocked_items_json,
  response_text, ingest_notice, extraction_json, grounding_json, injection_json,
  ai_mode, llm_called, timings_json, overridden_by, override_note, scenario_id,
  -- Written on insert, and read here. It was in the INSERT and in neither read path,
  -- so every case note came back absent while the column held it: the field looked
  -- dead rather than broken, which is the worst way for it to fail.
  case_summary,
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
  readonly claim_item_ids_json: string;
  readonly blocked_items_json: string;
  readonly response_text: string;
  readonly ingest_notice: string | null;
  readonly extraction_json: string | null;
  readonly grounding_json: string | null;
  readonly injection_json: string;
  readonly ai_mode: string;
  readonly llm_called: number;
  readonly timings_json: string;
  readonly overridden_by: string | null;
  readonly override_note: string | null;
  readonly scenario_id: string | null;
  readonly case_summary: string | null;
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
    claimItemIdsJson: row.claim_item_ids_json,
    blockedItemsJson: row.blocked_items_json,
    responseText: row.response_text,
    ingestNotice: row.ingest_notice,
    extractionJson: row.extraction_json,
    groundingJson: row.grounding_json,
    injectionJson: row.injection_json,
    aiMode: row.ai_mode,
    llmCalled: row.llm_called,
    timingsJson: row.timings_json,
    overriddenBy: row.overridden_by,
    overrideNote: row.override_note,
    scenarioId: row.scenario_id,
    caseSummary: row.case_summary,
  };
}

export function findRequestById(db: Db, id: string): PersistedRequest | null {
  const row = queryOne<RequestRow>(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM refund_requests WHERE id = ?`),
    id,
  );
  return row === null ? null : hydrate(row);
}

/**
 * The most recent request on a thread, for the staff briefing.
 *
 * `order_id IS ?` so a mid-clarify thread (no order resolved yet) joins on NULL
 * correctly, and `rowid` breaks the fixed-clock tie the same way the thread
 * merge does. Latest, not "first": a takeover hands a person the decision the
 * customer is currently reacting to, which is the one that matters.
 */
export function latestRequestForThread(
  db: Db,
  customerId: string,
  orderId: string | null,
): PersistedRequest | null {
  const row = queryOne<RequestRow>(
    db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM refund_requests
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    ),
    customerId,
    orderId,
  );
  return row === null ? null : hydrate(row);
}

export interface ListFilter {
  readonly decision?: string | undefined;
  readonly source?: 'scenario' | 'storefront' | undefined;
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
  // Scenario fixtures carry a scenario_id; storefront requests never do. The
  // discriminator is whether a demo id is attached, so the two can never
  // collide on the same row.
  if (filter.source === 'scenario') {
    clauses.push('scenario_id IS NOT NULL');
  } else if (filter.source === 'storefront') {
    clauses.push('scenario_id IS NULL');
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
 * A prior request from the same customer that looks like this one.
 *
 * This exists to stop one customer asking the same question twice and getting
 * two decisions. Both halves of that matter, and they are the reason the lookup
 * is this narrow:
 *
 *  - `fingerprint` is compared, not the raw text. A customer who retypes the
 *    same complaint with different spacing, or who hits send twice, produces
 *    two different strings for one problem. Normalising first is what makes the
 *    check catch the second send instead of only catching a byte-identical one.
 *  - The window is a parameter because "the same message again tomorrow" and
 *    "the same message again next month" are different situations. The first is
 *    a double-click; the second may be a legitimate new claim after the first
 *    was denied, and silently swallowing it would be the wrong answer.
 *
 * Ordered newest first so the caller can quote the request the customer most
 * recently made, and limited to the few nearest matches so a long history
 * cannot turn an intake check into a full-table scan.
 */
export interface DuplicateMatch {
  readonly id: string;
  readonly orderId: string | null;
  readonly decision: string;
  readonly createdAt: string;
  readonly message: string;
  readonly refundAmountCents: number;
}

export function findDuplicateRequests(
  db: Db,
  customerId: string,
  orderId: string | null,
  fingerprint: string,
  sinceIso: string,
  limit: number,
): readonly DuplicateMatch[] {
  // The message fingerprint alone is insufficient: the same wording can
  // describe two different orders. Match the deterministic order resolution as
  // well, including NULL for a genuinely unresolved/mid-clarify thread.
  const rows = queryAll<{
    id: string;
    order_id: string | null;
    decision: string;
    created_at: string;
    message: string;
    refund_amount_cents: number;
  }>(
    db.prepare(
      `SELECT id, order_id, decision, created_at, message, refund_amount_cents
         FROM refund_requests
        WHERE customer_id = ?
          AND order_id IS ?
          AND message_fingerprint = ?
          AND created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ),
    customerId,
    orderId,
    fingerprint,
    sinceIso,
    limit,
  );

  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    decision: row.decision,
    createdAt: row.created_at,
    message: row.message,
    refundAmountCents: row.refund_amount_cents,
  }));
}

/**
 * Reduces a message to something two submissions of the same complaint share.
 *
 * Case-folded, stripped of punctuation, and whitespace-collapsed, because the
 * differences between a double send and a genuine second claim are exactly
 * those - the words are the same. Digits are kept: an order number, an amount,
 * or a date in the text is usually the part that makes it a distinct claim, and
 * dropping them would merge two genuinely different complaints about different
 * orders into one.
 *
 * The output is only ever compared, never stored or shown, so a hash is
 * sufficient - the message itself is already in the row.
 */
export function messageFingerprint(message: string): string {
  return createHash('sha256')
    .update(
      message
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim(),
      'utf8',
    )
    .digest('hex');
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
  amountCents?: number,
): void {
  // Only a money decision may carry money, so anything else is written as $0 - an
  // override that merely changed the decision must not leave the old amount
  // live on the row. An approval re-derives the full eligible amount; a partial
  // refund carries the amount the admin named, defaulting to the eligible figure.
  const amount = overrideAmount(decision, eligibleAmountCents, amountCents);
  assertDecisionCoherent(decision, amount);
  db.prepare(
    `UPDATE refund_requests
        SET decision = ?, refund_amount_cents = ?, overridden_by = ?, override_note = ?
      WHERE id = ?`,
  ).run(decision, amount, agentId, note, id);
}

function overrideAmount(
  decision: Decision,
  eligibleAmountCents: number,
  amountCents: number | undefined,
): number {
  if (decision === 'approved') {
    return eligibleAmountCents;
  }
  if (decision === 'partial_refund') {
    return amountCents ?? eligibleAmountCents;
  }
  return 0;
}

/**
 * Money safety, stated once: money is authorised only by a money decision.
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
  if (MONEY_DECISIONS.has(decision)) {
    if (amountCents <= 0) {
      const msg =
        amountCents === 0
          ? 'nothing on this order is eligible for refund, so it cannot be approved. Check the blocked items in the decision trace.'
          : `a ${decision} request must carry a positive amount`;
      throw new IncoherentDecisionError(msg);
    }
    return;
  }
  if (amountCents !== 0) {
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
