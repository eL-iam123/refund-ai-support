import type { AdminStatsDto, Decision } from '@refund/shared';
import { DECISIONS } from '@refund/shared';
import type { Db } from './connection.js';
import { queryAll, queryOne } from './sql.js';
import type { LlmCallRecord } from './records.js';

/**
 * Read-only aggregates for the admin dashboard.
 *
 * Deliberately plain SQL: these are counts over rows the API itself wrote, so
 * there is nothing to abstract. `clampsFired` counts the rows whose stored
 * overrides include a clamp, which is the number a reviewer actually wants to
 * see grow when the injection-resistance claims are honest.
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
}

interface LatencyRow {
  readonly average_ms: number | null;
}

function countOf(db: Db, sql: string, ...params: unknown[]): number {
  const row = queryOne<CountRow>(db.prepare(sql), ...params);
  return row === null ? 0 : row.n;
}

function emptyDecisionTally(): Record<Decision, number> {
  return { approved: 0, denied: 0, escalated: 0 };
}

export function adminStats(db: Db, aiMode: string): AdminStatsDto {
  const byDecision = emptyDecisionTally();
  const rows = queryAll<DecisionRow>(
    db.prepare('SELECT decision, COUNT(*) AS n FROM refund_requests GROUP BY decision'),
  );
  for (const row of rows) {
    if (isDecision(row.decision)) {
      byDecision[row.decision] = row.n;
    }
  }

  const overrides = queryAll<OverrideRow>(db.prepare('SELECT overrides_json, injection_json FROM refund_requests'));
  let clampsFired = 0;
  let injectionAttempts = 0;
  for (const row of overrides) {
    if (containsClamp(row.overrides_json)) {
      clampsFired += 1;
    }
    if (containsInjection(row.injection_json)) {
      injectionAttempts += 1;
    }
  }

  const latency = queryOne<LatencyRow>(
    db.prepare(
      `SELECT AVG(total_ms) AS average_ms FROM (
         SELECT SUM(json_each.value) AS total_ms
         FROM refund_requests, json_each(refund_requests.timings_json)
         GROUP BY refund_requests.id
       )`,
    ),
  );

  return {
    total: countOf(db, 'SELECT COUNT(*) AS n FROM refund_requests'),
    byDecision,
    llmCalls: countOf(db, 'SELECT COUNT(*) AS n FROM llm_calls'),
    injectionAttempts,
    clampsFired,
    humanOverrides: countOf(db, 'SELECT COUNT(*) AS n FROM refund_requests WHERE overridden_by IS NOT NULL'),
    aiMode,
    averageLatencyMs: Math.round(latency?.average_ms ?? 0),
  };
}

function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

/** Stored override JSON is machine-written, so a substring test is enough here. */
function containsClamp(overridesJson: string): boolean {
  return overridesJson.includes('clamped') || overridesJson.includes('zeroed');
}

function containsInjection(injectionJson: string): boolean {
  return injectionJson.includes('"detected":true');
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
