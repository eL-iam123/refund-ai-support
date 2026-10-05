import { createHash } from 'node:crypto';
import type { ClaimExtraction, GroundingResult, RefundDecision } from '@refund/shared';
import { messageFingerprint, type NewRequestRow } from './requestRepository.js';
import type { ProcessResult } from '../orchestrator.js';

/**
 * The one place a pipeline decision becomes a request row.
 *
 * The live chat route and the history seeder are different callers of the same
 * conversion - a seeded run is nothing but a live run that happened at boot -
 * and they must produce identical rows. Kept here, the mapping is written once
 * and every decision, seeded or live, has the same shape of trace, grounding,
 * injection scan and timings on its way into the database.
 */

export function rowFromDecision(args: {
  readonly requestId: string;
  readonly customerId: string;
  readonly message: string;
  readonly now: Date;
  readonly scenarioId: string | null;
  readonly result: Extract<ProcessResult, { stage: 'decided' }>;
}): NewRequestRow {
  const { requestId, customerId, message, now, scenarioId, result } = args;
  return {
    id: requestId,
    createdAt: now.toISOString(),
    customerId,
    customerName: result.customer.name,
    orderId: result.resolvedOrderId,
    message,
    // Lets an auditor prove the stored message was not edited after the
    // decision was made, without keeping a second copy of it anywhere.
    messageSha256: sha256(message),
    // Derived from the message here, not accepted from the caller. A caller that
    // supplies its own fingerprint can make two different messages collide, and
    // a duplicate check that can be defeated by choosing a hash is decoration.
    messageFingerprint: messageFingerprint(message),
    ...decisionColumns(result.decision),
    responseText: result.responseText,
    ingestNotice: result.notice,
    claimItemIdsJson: JSON.stringify(result.itemIds),
    extractionJson: toJson(result.extraction),
    groundingJson: toJson(result.grounding),
    injectionJson: JSON.stringify(result.injection),
    aiMode: result.aiMode,
    llmCalled: result.llmCalled,
    timingsJson: JSON.stringify(result.timings),
    scenarioId,
    caseSummary: (result as { readonly caseSummary?: string | null }).caseSummary ?? null,
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
  | 'claimItemIdsJson'
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