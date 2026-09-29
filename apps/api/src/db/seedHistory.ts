import { createHash } from 'node:crypto';
import { SCENARIOS, type Scenario } from '@refund/shared';
import { insertRequest, insertAuditEvent, type NewRequestRow } from './requestRepository.js';
import { authoriseRefund, settleRefund } from './refundLedger.js';
import { formatCents } from '../lib/money.js';
import type { Db } from './connection.js';
import { findCustomer } from './sql.js';

/**
 * A little decision history, so the console opens onto a product rather than an
 * empty table.
 *
 * Every field here is copied from a canonical scenario, and the conformance suite
 * already asserts the live engine produces exactly these decisions for those
 * inputs - so this is recorded history, not invented history. Writing it as
 * literal rows is the point: the alternative was calling a model at boot, which
 * would make seeding need a network, cost money, and produce a different answer
 * on every start.
 *
 * It runs from `index.ts` on a fresh database only. Deliberately *not* called
 * from `seedDatabase`, because the tests share that one and a seeded reservation
 * would change what R-06b is supposed to decide.
 */

/** Scenarios chosen to cover each outcome the dashboard needs to display. */
const HISTORY: readonly { readonly scenarioId: string; readonly settled: boolean }[] = [
  { scenarioId: 'S-01', settled: true },
  { scenarioId: 'S-04', settled: false },
  { scenarioId: 'S-02', settled: false },
  { scenarioId: 'S-13', settled: false },
  { scenarioId: 'S-05', settled: false },
];

/** Spaced out over the last few days so the "recent" list has a real shape. */
function createdAt(now: Date, daysAgo: number, hour: number): string {
  const at = new Date(now.getTime() - daysAgo * 86_400_000);
  at.setUTCHours(hour, (daysAgo * 7) % 60, 0, 0);
  return at.toISOString();
}

/** Seeded rows carry a real fingerprint so a seeded customer re-asking is recognised as a repeat. */
function messageFingerprint(message: string): string {
  return createHash('sha256')
    .update(
      message
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim(),
    )
    .digest('hex');
}

function messageHash(message: string): string {
  return createHash('sha256').update(message).digest('hex');
}

function rowFor(scenario: Scenario, requestId: string, createdAt: string): NewRequestRow {
  const rules = [...scenario.expectedRules, ...(scenario.expectedSupportingRules ?? [])];
  const trace = rules.map((ruleId) => ({
    ruleId,
    ruleClass: 'seeded',
    scope: 'order',
    // The deciding rule carries the scenario's outcome; the rest are recorded as
    // having passed, which is what "reached this clause and did not fire" means.
    outcome: ruleId === (scenario.expectedRules[0] ?? ruleId)
      ? scenario.expectedDecision
      : 'pass',
    evidence: `seeded history: ${ruleId} for ${scenario.id}`,
    policyRef: 'REFUND_POLICY.md',
    itemIds: [] as string[],
  }));

  return {
    id: requestId,
    createdAt,
    customerId: scenario.customer.key,
    customerName: scenario.customer.name,
    orderId: scenario.orderId ?? null,
    message: scenario.message,
    decision: scenario.expectedDecision,
    refundAmountCents: scenario.expectedAmountCents,
    eligibleAmountCents: scenario.expectedAmountCents,
    messageSha256: messageHash(scenario.message),
    messageFingerprint: messageFingerprint(scenario.message),
    summary: `${scenario.goal} (${scenario.id})`,
    policyRef: 'REFUND_POLICY.md',
    traceJson: JSON.stringify(trace),
    overridesJson: '[]',
    eligibleItemIdsJson: '[]',
    blockedItemsJson: '[]',
    extractionJson: null,
    groundingJson: null,
    injectionJson: JSON.stringify({
      detected: false,
      action: 'none',
      signals: [],
    }),
    aiMode: scenario.expectsLlmCall ? 'seeded' : 'not-called',
    llmCalled: scenario.expectsLlmCall,
    timingsJson: '[]',
    responseText: `Seeded example request (${scenario.id}): ${scenario.name}.`,
    scenarioId: scenario.id,
  };
}

export function seedRequestHistory(db: Db, now: Date): number {
  let created = 0;

  HISTORY.forEach((entry, index) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === entry.scenarioId);
    // S-09 deliberately points at an order that does not exist; a history row
    // with no order would have no balance to reason about, so it is skipped.
    if (scenario === undefined || scenario.orderId === null) {
      return;
    }
    if (findCustomer(db, scenario.customer.key, now) === null) {
      return;
    }
    // A fixed id per scenario, so a restart cannot duplicate the history and a
    // reviewer can find the row they saw last time.
    const requestId = `seed-${scenario.id.toLowerCase()}`;
    const existing = db
      .prepare('SELECT 1 AS present FROM refund_requests WHERE id = ?')
      .get(requestId);
    if (existing !== undefined) {
      return;
    }

    const at = createdAt(now, HISTORY.length - index, 9 + index);
    const row = rowFor(scenario, requestId, at);

    const write = db.transaction(() => {
      insertRequest(db, row);
      insertAuditEvent(
        db,
        row.id,
        row.createdAt,
        'decision',
        `${row.decision} ${formatCents(row.refundAmountCents)} (seeded history)`,
      );
      if (row.decision === 'approved' && row.refundAmountCents > 0) {
        const reservation = authoriseRefund(db, {
          requestId: row.id,
          orderId: row.orderId ?? '',
          customerId: row.customerId,
          amountCents: row.refundAmountCents,
          now,
        });
        insertAuditEvent(
          db,
          row.id,
          row.createdAt,
          'refund_authorised',
          `${formatCents(reservation.amountCents)} pending human verification`,
        );
        // One is left awaiting verification on purpose, so the review queue has
        // something in it the moment somebody opens the console.
        if (entry.settled) {
          // Through the ledger, not around it. A hand-written UPDATE that
          // satisfied the status check but skipped `verified_at` is exactly the
          // row the table's constraints exist to refuse, and the table refused
          // it. Settling is how a person verifies a claim, so the seeded person
          // is named in the row.
          settleRefund(db, reservation.id, 'seed@refund.test', new Date(at));
          insertAuditEvent(db, row.id, row.createdAt, 'refund_settled', 'settled (seeded history)');
        }
      }
    });
    write();
    created += 1;
  });

  return created;
}
