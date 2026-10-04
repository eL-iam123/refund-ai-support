import type { AdminStatsDto, Decision } from '@refund/shared';
import { DECISIONS } from '@refund/shared';
import type { Db } from './connection.js';
import { queryAll, queryOne } from './sql.js';
import type { LlmCallRecord } from './records.js';

/**
 * Read-only aggregates for the admin dashboard.
 *
 * Deliberately plain SQL: these are counts over rows the API itself wrote, so
 * there is nothing to abstract.
 *
 * The two numbers worth arguing about are here rather than computed in the
 * frontend, because the frontend would compute them differently each time and
 * the disagreement is the point:
 *
 * - `clampsFired` counts requests whose stored overrides record that the policy
 *   paid something other than what was asked for - the figure clamped, the amount
 *   zeroed, a model's proposal overruled. It is the number that has to grow when
 *   the injection-resistance claims are honest, because a system that agreed with
 *   every customer every time would be indistinguishable from one that was never
 *   consulted. Matched on the override *codes* rather than on the JSON text: a
 *   substring test also fires on a human-readable detail that happens to contain
 *   the word, which is how a metric starts counting things it never measured.
 * - `modelSaidYesPolicySaidNo` is the dangerous direction specifically: a claim
 *   for money was read and the policy refused it. That is the case where a bug in
 *   the resolver shows up as a payout, so it is counted on its own. The model no
 *   longer proposes an outcome at all, so "said yes" now means what is recorded -
 *   a claim naming a figure that came back denied.
 */

interface CountRow {
  readonly n: number;
}

interface DecisionRow {
  readonly decision: string;
  readonly n: number;
}

interface OverrideRow {
  readonly overrides_json: string;
  readonly injection_json: string;
  readonly extraction_json: string | null;
  readonly decision: string;
}

interface SumRow {
  readonly count: number;
  readonly cents: number | null;
}

interface LatencyRow {
  readonly average_ms: number | null;
  readonly max_ms: number | null;
}

interface ProviderRow {
  readonly provider: string;
  readonly attempts: number;
  readonly failed: number;
}

interface TokenRow {
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
}

interface DailyRow {
  readonly day: string;
  readonly total: number;
  readonly decision: string;
  readonly n: number;
}

function countOf(db: Db, sql: string, ...params: unknown[]): number {
  const row = queryOne<CountRow>(db.prepare(sql), ...params);
  return row === null ? 0 : row.n;
}

function emptyDecisionTally(): Record<Decision, number> {
  return { approved: 0, denied: 0, escalated: 0, partial_refund: 0, exchange: 0, store_credit: 0 };
}

/** Requests per decision, ignoring any value the enum does not recognise. */
function decisionTally(db: Db): Record<Decision, number> {
  const tally = emptyDecisionTally();
  const rows = queryAll<DecisionRow>(
    db.prepare('SELECT decision, COUNT(*) AS n FROM refund_requests GROUP BY decision'),
  );
  for (const row of rows) {
    if (isDecision(row.decision)) {
      tally[row.decision] = row.n;
    }
  }
  return tally;
}

/**
 * How often each guard rail actually fired.
 *
 * Counted by reading the stored decision record rather than by replaying rules,
 * because the record is the thing a reviewer can audit: a clamp that is not in
 * the overrides never happened, however the resolver computed it.
 */
function guardRailCounts(db: Db): {
  readonly clampsFired: number;
  readonly injectionAttempts: number;
  readonly modelSaidYesPolicySaidNo: number;
} {
  const rows = queryAll<OverrideRow>(
    db.prepare('SELECT overrides_json, injection_json, extraction_json, decision FROM refund_requests'),
  );
  let clampsFired = 0;
  let injectionAttempts = 0;
  let refusedClaim = 0;
  for (const row of rows) {
    if (containsClamp(row.overrides_json)) {
      clampsFired += 1;
    }
    if (containsInjection(row.injection_json)) {
      injectionAttempts += 1;
    }
    if (row.decision === 'denied' && modelSaidYesPolicySaidNo(row.extraction_json)) {
      refusedClaim += 1;
    }
  }
  return { clampsFired, injectionAttempts, modelSaidYesPolicySaidNo: refusedClaim };
}

/**
 * End-to-end time per request.
 *
 * Summed across stages first, because `timings_json` is an array of named stages
 * and the mean of a mean would understate the slowest request by averaging
 * stages rather than requests.
 */
function latencyBucket(db: Db): { readonly averageMs: number; readonly p95Ms: number; readonly maxMs: number } {
  const row = queryOne<LatencyRow>(
    db.prepare(
      `SELECT AVG(total_ms) AS average_ms, MAX(total_ms) AS max_ms FROM (
         SELECT SUM(json_each.value) AS total_ms
         FROM refund_requests, json_each(refund_requests.timings_json)
         GROUP BY refund_requests.id
       )`,
    ),
  );
  return {
    averageMs: Math.round(row?.average_ms ?? 0),
    p95Ms: p95LatencyMs(db),
    maxMs: Math.round(row?.max_ms ?? 0),
  };
}

export function adminStats(
  db: Db,
  aiMode: string,
  ai: { available: boolean; reason: string | null; models: readonly { model: string; state: 'closed' | 'open' | 'half_open'; consecutiveFailures: number }[] },
): AdminStatsDto {
  const latency = latencyBucket(db);
  const guard = guardRailCounts(db);
  return {
    total: countOf(db, 'SELECT COUNT(*) AS n FROM refund_requests'),
    byDecision: decisionTally(db),
    llmCalls: countOf(db, 'SELECT COUNT(*) AS n FROM llm_calls'),
    injectionAttempts: guard.injectionAttempts,
    clampsFired: guard.clampsFired,
    humanOverrides: countOf(db, 'SELECT COUNT(*) AS n FROM refund_requests WHERE overridden_by IS NOT NULL'),
    aiMode,
    aiAvailable: ai.available,
    aiUnavailableReason: ai.reason,
    models: [...ai.models],
    averageLatencyMs: latency.averageMs,
    pendingVerification: moneyBucket(db, 'pending_verification'),
    settled: moneyBucket(db, 'settled'),
    released: moneyBucket(db, 'released'),
    latency,
    llm: llmBucket(db),
    topRules: topRules(db),
    daily: dailyVolume(db),
    clampRate: { clamped: guard.clampsFired, modelSaidYesPolicySaidNo: guard.modelSaidYesPolicySaidNo },
  };
}

/** Count and total for one refund status. */
function moneyBucket(db: Db, status: string): { count: number; amountCents: number } {
  const row = queryOne<SumRow>(
    db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS cents FROM refunds WHERE status = ?'),
    status,
  );
  return { count: row?.count ?? 0, amountCents: row?.cents ?? 0 };
}

/**
 * The 95th percentile, computed in SQLite rather than by loading every row.
 *
 * `NTILE`-style window functions are avoided for a reason that matters: this has
 * to keep working on the SQLite build the tests and the container both use, and
 * ordering the rows on disk and picking the index is both faster and portable
 * where a window function would be neither.
 */
function p95LatencyMs(db: Db): number {
  const totals = queryAll<{ total_ms: number }>(
    db.prepare(
      `SELECT SUM(json_each.value) AS total_ms
       FROM refund_requests, json_each(refund_requests.timings_json)
       GROUP BY refund_requests.id
       ORDER BY total_ms`,
    ),
  );
  if (totals.length === 0) {
    return 0;
  }
  // Nearest-rank: the smallest value at or above 95% of the distribution. With
  // few requests this is simply the slowest one, which is the honest answer
  // rather than an interpolation between samples that were never observed.
  const rank = Math.min(Math.max(Math.ceil(totals.length * 0.95) - 1, 0), totals.length - 1);
  const slowest: { total_ms: number } | undefined = totals[rank];
  return Math.round(slowest?.total_ms ?? 0);
}

function llmBucket(db: Db): AdminStatsDto['llm'] {
  const attempts = countOf(db, 'SELECT COUNT(*) AS n FROM llm_calls');
  const failed = countOf(db, 'SELECT COUNT(*) AS n FROM llm_calls WHERE ok = 0');
  const latency = queryOne<LatencyRow>(
    db.prepare('SELECT AVG(latency_ms) AS average_ms, NULL AS max_ms FROM llm_calls'),
  );
  const tokens = queryOne<TokenRow>(
    db.prepare(
      'SELECT SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens FROM llm_calls',
    ),
  );
  return {
    attempts,
    failed,
    averageMs: Math.round(latency?.average_ms ?? 0),
    promptTokens: tokens?.prompt_tokens ?? 0,
    completionTokens: tokens?.completion_tokens ?? 0,
    providers: queryAll<ProviderRow>(
      db.prepare(
        'SELECT provider, COUNT(*) AS attempts, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM llm_calls GROUP BY provider ORDER BY attempts DESC',
      ),
    ),
  };
}

/**
 * The rules that actually fire.
 *
 * Read from the stored traces rather than from the rule definitions, so the
 * answer cannot be "every rule exists" - only "this is what decided". A rule
 * that never appears here is either unreachable or misnamed, and both are worth
 * knowing.
 */
function topRules(db: Db): AdminStatsDto['topRules'] {
  const counted = new Map<string, number>();
  const traces = queryAll<{ trace_json: string }>(db.prepare('SELECT trace_json FROM refund_requests'));
  for (const row of traces) {
    for (const ruleId of firedRules(row.trace_json)) {
      counted.set(ruleId, (counted.get(ruleId) ?? 0) + 1);
    }
  }
  return [...counted.entries()]
    .map(([ruleId, fired]) => ({ ruleId, fired }))
    .sort((a, b) => b.fired - a.fired)
    .slice(0, 12);
}

/** Only non-`pass` outcomes count as "fired". */
function firedRules(traceJson: string): readonly string[] {
  const parsed: unknown = JSON.parse(traceJson);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of parsed) {
    if (isRecord(entry) && entry.outcome !== 'pass' && typeof entry.ruleId === 'string') {
      ids.push(entry.ruleId);
    }
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Requests per day, oldest first.
 *
 * Seeded history is spread over a handful of days, so a single-day total would
 * look like a trend and be one. Fourteen days is the window a support lead asks
 * about, and it is long enough to include the seeded rows even on a fresh
 * database.
 */
function dailyVolume(db: Db): AdminStatsDto['daily'] {
  // One row per (day, decision) rather than one row per day with a fixed set of
  // outcome columns: a fixed set cannot hold the outcomes the discretion layer
  // added, and a chart whose series do not add up to its own total is worse than
  // no chart, because it looks like the missing cases went somewhere.
  const rows = queryAll<DailyRow>(
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, decision, COUNT(*) AS n
         FROM refund_requests
        WHERE created_at >= datetime('now', '-14 days')
        GROUP BY day, decision
        ORDER BY day`,
    ),
  );

  const days = new Map<string, { total: number; byDecision: Record<Decision, number> }>();
  for (const row of rows) {
    const day = days.get(row.day) ?? { total: 0, byDecision: emptyDecisionTally() };
    day.total += row.n;
    if (isDecision(row.decision)) {
      day.byDecision[row.decision] += row.n;
    }
    days.set(row.day, day);
  }

  return [...days.entries()].map(([day, value]) => ({ day, ...value }));
}

function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

/**
 * The override codes that record a disagreement about money.
 *
 * Listed rather than pattern-matched, because this list is the definition of what
 * "clamped" means to the dashboard and a new code should be a deliberate addition.
 */
const CLAMP_CODES: ReadonlySet<string> = new Set([
  'ai_proposal_rejected',
  'ai_proposed_approve_clamped_to_deny',
  'ai_proposed_approve_clamped_to_escalate',
  'amount_clamped_to_order_value',
  'amount_limited_to_disputed_items',
  'amount_zeroed_on_deny',
  'discretion_approve',
  'discretion_partial_refund',
]);

function parseJsonRecord(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A row that will not parse is a bug worth not crashing the dashboard over.
    return null;
  }
}

function parseJsonArray(json: string): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Whether the decision record says the policy paid something other than was asked.
 *
 * Matched against the override codes, not against the serialised text. A
 * substring test over the whole record also fires on the human-readable `detail`
 * of an unrelated override, and it fires on `untrusted_extraction_discarded`'s
 * neighbours by accident - a dashboard figure that counts words is a figure that
 * will be wrong in a way nobody can reproduce.
 */
function containsClamp(overridesJson: string): boolean {
  const overrides = parseJsonArray(overridesJson);
  return overrides.some((override) => {
    const code = isRecord(override) ? override['code'] : null;
    return typeof code === 'string' && CLAMP_CODES.has(code);
  });
}

function containsInjection(injectionJson: string): boolean {
  return injectionJson.includes('"detected":true');
}

/**
 * Whether a claim for money was read and then refused.
 *
 * The dangerous direction, and the one a resolver bug shows up in: a customer
 * asked for a figure, the intake layer read the claim, and the policy still paid
 * nothing. Read from the stored extraction rather than recomputed, so the number
 * is auditable against the record rather than a second opinion.
 *
 * A stored extraction is not by itself the answer - every decision carries the
 * claim the model read, including the ones where it agreed with the customer. The
 * signal is a claim that *named a figure* meeting a denial, which is the case
 * where money was wanted and did not move. A `null` extraction means no model ran,
 * which is not the same as a model saying no, and is excluded.
 */
function modelSaidYesPolicySaidNo(extractionJson: string | null): boolean {
  if (extractionJson === null) {
    return false;
  }
  // The column holds the extraction itself, flattened - not an envelope with a
  // `claim` key inside it. Reading a key that is never written is how this figure
  // sat at zero forever while the rows it was meant to describe were right there.
  const claim = parseJsonRecord(extractionJson);
  if (claim === null) {
    return false;
  }
  const intent = claim['intent'];
  const claimed = claim['claimedAmountCents'];
  return intent === 'refund' && typeof claimed === 'number' && claimed > 0;
}

interface LlmCallRow {
  readonly id: number;
  readonly request_id: string;
  readonly at: string;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly ok: number;
  readonly latency_ms: number;
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly error: string | null;
}

/** `SELECT *` returns snake_case; `LlmCallRecord` is declared in camelCase. */
function hydrateCall(row: LlmCallRow): LlmCallRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    at: row.at,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    attempt: row.attempt,
    ok: row.ok,
    latencyMs: row.latency_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    error: row.error,
  };
}

export function listLlmCalls(db: Db, requestId: string): LlmCallRecord[] {
  return queryAll<LlmCallRow>(
    db.prepare('SELECT * FROM llm_calls WHERE request_id = ? ORDER BY id'),
    requestId,
  ).map(hydrateCall);
}
