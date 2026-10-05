import type {
  BlockedItemDto,
  ClaimExtractionDto,
  GroundingDto,
  InjectionScanDto,
  OverrideRecordDto,
  RefundDecisionDto,
  RefundDto,
  RefundRequestDto,
  RefundRequestSummaryDto,
  RuleEvaluationDto,
  StageTiming,
} from '@refund/shared';
import type { PersistedRequest } from '../db/records.js';
import type { RefundRecord } from '../db/refundLedger.js';

/**
 * Turns stored rows into API DTOs.
 *
 * The `*_json` columns are written by exactly one code path (the chat route),
 * so a parse failure means the row is corrupt - a genuine bug worth a loud
 * error rather than a silently empty field that an operator would read as
 * "the model decided nothing".
 */
function parse<T>(raw: string, column: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`corrupt ${column} column: ${raw.slice(0, 120)}`, { cause });
  }
}

function parseOrNull<T>(raw: string | null, column: string): T | null {
  return raw === null ? null : parse<T>(raw, column);
}

export function toDecisionDto(row: PersistedRequest): RefundDecisionDto {
  return {
    decision: row.decision,
    refundAmountCents: row.refundAmountCents,
    eligibleAmountCents: row.eligibleAmountCents,
    currency: 'USD',
    summary: row.summary,
    policyRef: row.policyRef,
    trace: parse<RuleEvaluationDto[]>(row.traceJson, 'trace_json'),
    overrides: parse<OverrideRecordDto[]>(row.overridesJson, 'overrides_json'),
    eligibleItemIds: parse<string[]>(row.eligibleItemIdsJson, 'eligible_item_ids_json'),
    blockedItems: parse<BlockedItemDto[]>(row.blockedItemsJson, 'blocked_items_json'),
    // Live-at-decision-time figures, deliberately not persisted. A replayed row
    // reports zero rather than a stale balance, because a number that was true
    // when the decision was made and is wrong now is worse than an absent one.
    // Nothing reads these to decide anything: the customer-facing text was
    // composed when they were accurate and is stored alongside the row.
    outstandingAmountCents: 0,
    outstandingState: 'none',
  };
}

export function toRequestDto(row: PersistedRequest): RefundRequestDto {
  return {
    id: row.id,
    createdAt: row.createdAt,
    customerId: row.customerId,
    customerName: row.customerName,
    orderId: row.orderId,
    source: row.scenarioId === null ? 'storefront' : 'scenario',
    message: row.message,
    decision: toDecisionDto(row),
    responseText: row.responseText,
    ingestNotice: row.ingestNotice,
    extraction: parseOrNull<ClaimExtractionDto>(row.extractionJson, 'extraction_json'),
    grounding: parseOrNull<GroundingDto>(row.groundingJson, 'grounding_json'),
    injection: parse<InjectionScanDto>(row.injectionJson, 'injection_json'),
    aiMode: row.aiMode,
    llmCalled: row.llmCalled === 1,
    timings: parse<StageTiming[]>(row.timingsJson, 'timings_json'),
    overriddenBy: row.overriddenBy,
    overrideNote: row.overrideNote,
    caseSummary: row.caseSummary,
  };
}

/** List rows omit the heavy trace/extraction columns. */
export function toSummaryDto(row: PersistedRequest): RefundRequestSummaryDto {
  const trace = parse<RuleEvaluationDto[]>(row.traceJson, 'trace_json');
  const injection = parse<InjectionScanDto>(row.injectionJson, 'injection_json');

  return {
    id: row.id,
    createdAt: row.createdAt,
    customerId: row.customerId,
    customerName: row.customerName,
    orderId: row.orderId,
    source: row.scenarioId === null ? 'storefront' : 'scenario',
    message: row.message,
    decision: row.decision,
    refundAmountCents: row.refundAmountCents,
    reasonCodes: trace.filter((entry) => entry.outcome !== 'pass').map((entry) => entry.ruleId),
    aiMode: row.aiMode,
    llmCalled: row.llmCalled === 1,
    injectionDetected: injection.detected,
    overriddenBy: row.overriddenBy,
  };
}

export function toRefundDto(row: RefundRecord): RefundDto {
  return {
    id: row.id,
    requestId: row.requestId,
    orderId: row.orderId,
    customerId: row.customerId,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt,
    settledAt: row.settledAt,
    releasedAt: row.releasedAt,
    releaseReason: row.releaseReason,
  };
}
