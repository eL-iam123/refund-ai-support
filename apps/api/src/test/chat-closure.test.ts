import { describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { TEST_NOW } from './helpers.js';
import {
  ChatNotFinalizedError,
  chatClosureForThread,
  closeFinalizedChat,
  finalizedRequestId,
  isChatClosed,
} from '../db/chatClosures.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
import { authoriseRefund, settleRefund } from '../db/refundLedger.js';
import type { Decision } from '@refund/shared';

/**
 * Closing a thread is the last thing that happens to a conversation.
 *
 * These tests are about what the closure is allowed to claim. The stored
 * `final_state` is read by people who will not see the ledger sitting next to it,
 * so a closure that says `denied` above an authorisation is a false record and the
 * worst thing this table can hold. There was no coverage of any of it before, which
 * is how a partial refund came to be recorded as a denial and an exchange could not
 * be closed at all.
 */

interface Fixture {
  readonly db: Db;
  readonly customerId: string;
  readonly orderId: string;
}

function fixture(): Fixture {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  const row = db
    .prepare('SELECT id AS order_id, customer_id FROM orders ORDER BY id LIMIT 1')
    .get() as { order_id: string; customer_id: string } | undefined;
  if (row === undefined) {
    throw new Error('seed produced no orders');
  }
  return { db, customerId: row.customer_id, orderId: row.order_id };
}

/**
 * A request written directly, so each test is about closure and not about whether
 * a particular message happens to reach a particular outcome.
 */
function requestRow(f: Fixture, decision: Decision, requestId: string, amountCents = 0): NewRequestRow {
  const at = TEST_NOW.toISOString();
  return {
    id: requestId,
    createdAt: at,
    customerId: f.customerId,
    customerName: 'Test Customer',
    orderId: f.orderId,
    message: 'fixture claim',
    messageSha256: '0'.repeat(64),
    messageFingerprint: '0'.repeat(64),
    decision,
    refundAmountCents: amountCents,
    eligibleAmountCents: amountCents,
    summary: 'fixture',
    policyRef: 'REFUND_POLICY.md §5.1',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: '[]',
    blockedItemsJson: '[]',
    responseText: 'fixture',
    extractionJson: null,
    groundingJson: null,
    injectionJson: '{"detected":false,"signals":[],"obfuscationNoted":false}',
    aiMode: 'fake',
    llmCalled: false,
    timingsJson: '[]',
    scenarioId: null,
  };
}

/** A money decision with its reservation settled, which is what finalises it. */
function settledMoneyRequest(f: Fixture, decision: 'approved' | 'partial_refund', requestId: string): void {
  const amount = 5_000;
  insertRequest(f.db, requestRow(f, decision, requestId, amount));
  const reservation = authoriseRefund(f.db, {
    requestId,
    orderId: f.orderId,
    customerId: f.customerId,
    amountCents: amount,
    now: TEST_NOW,
  });
  settleRefund(f.db, reservation.id, 'agent@example.com', TEST_NOW);
}

describe('a money decision finalises a thread only once the money has moved', () => {
  it('closes an approved thread after the refund settles', () => {
    const f = fixture();
    settledMoneyRequest(f, 'approved', 'REQ-APPROVED');

    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe('approved');
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(true);
    f.db.close();
  });

  it('closes a partial refund as a partial refund, not as a denial', () => {
    const f = fixture();
    settledMoneyRequest(f, 'partial_refund', 'REQ-PARTIAL');

    // The bug this pins: a partial refund holds money like an approval does, and
    // used to be neither closeable nor recordable - so the thread stayed open
    // forever and the record, where it did exist, called it `denied`.
    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe('partial_refund');
    expect(chatClosureForThread(f.db, f.customerId, f.orderId)?.finalState).toBe('partial_refund');
    f.db.close();
  });

  it('holds both money decisions open while the reservation is still pending', () => {
    for (const decision of ['approved', 'partial_refund'] as const) {
      const f = fixture();
      const requestId = `REQ-PENDING-${decision}`;
      insertRequest(f.db, requestRow(f, decision, requestId, 5_000));
      authoriseRefund(f.db, {
        requestId,
        orderId: f.orderId,
        customerId: f.customerId,
        amountCents: 5_000,
        now: TEST_NOW,
      });

      expect(finalizedRequestId(f.db, f.customerId, f.orderId), decision).toBeNull();
      expect(() =>
        closeFinalizedChat(f.db, {
          customerId: f.customerId,
          orderId: f.orderId,
          closedBy: 'agent@example.com',
          now: TEST_NOW,
        }),
      ).toThrow(ChatNotFinalizedError);
      f.db.close();
    }
  });
});

describe('a decision that owes the customer something keeps the thread open', () => {
  it('does not close a thread whose dispute still needs confirming', () => {
    // The customer was told a member of the team would confirm the details in this
    // thread, so the decision alone is not enough: with nobody having taken the
    // thread, closing it would end the conversation with that promise outstanding.
    // See the next describe for what does finalise them.
    for (const decision of ['exchange', 'store_credit', 'escalated'] as const) {
      const f = fixture();
      insertRequest(f.db, requestRow(f, decision, `REQ-OPEN-${decision}`, 0));

      expect(finalizedRequestId(f.db, f.customerId, f.orderId), decision).toBeNull();
      f.db.close();
    }
  });

  it('closes a denied thread once no appeal is open', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'denied', 'REQ-DENIED', 0));

    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe('denied');
    f.db.close();
  });

  it('holds a denied thread open while an appeal is undecided', () => {
    const f = fixture();
    const requestId = 'REQ-APPEALED';
    insertRequest(f.db, requestRow(f, 'denied', requestId, 0));
    f.db
      .prepare(
        `INSERT INTO appeals (id, created_at, customer_id, request_id, reason)
         VALUES ('AP-1', ?, ?, ?, 'it arrived damaged')`,
      )
      .run(TEST_NOW.toISOString(), f.customerId, requestId);

    expect(finalizedRequestId(f.db, f.customerId, f.orderId)).toBeNull();
    f.db.close();
  });
});

describe('an alternative outcome closes once an agent has handled the thread', () => {
  /**
   * The customer is told a member of the team will confirm the details in this
   * thread, so the confirmation has to be possible before the conversation ends.
   * A finished handoff on the same order is the evidence that it happened - and
   * without it these outcomes could never be closed at all, because the request is
   * resolved but the money question is moot.
   */
  it.each(['exchange', 'store_credit'] as const)('holds a %s thread open until a handoff has ended', (decision) => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, decision, `REQ-ALT-${decision}`, 0));
    insertHandoff(f, 'HAND-OPEN', 'agent@example.com', TEST_NOW, null);

    expect(finalizedRequestId(f.db, f.customerId, f.orderId), 'while the handoff is running').toBeNull();

    f.db.prepare('UPDATE handoffs SET ended_at = ? WHERE id = ?').run(TEST_NOW.toISOString(), 'HAND-OPEN');

    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe(decision);
    f.db.close();
  });

  it('ignores a handoff on a different order', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'exchange', 'REQ-ALT-OTHER', 0));
    insertHandoff(f, 'HAND-ELSEWHERE', 'agent@example.com', TEST_NOW, TEST_NOW, 'ORD-SOMEWHERE-ELSE');

    expect(finalizedRequestId(f.db, f.customerId, f.orderId)).toBeNull();
    f.db.close();
  });

  it('still refuses an escalated thread, because a person is owed an answer', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'escalated', 'REQ-STILL-OPEN', 0));
    insertHandoff(f, 'HAND-DONE', 'agent@example.com', TEST_NOW, TEST_NOW);

    expect(finalizedRequestId(f.db, f.customerId, f.orderId)).toBeNull();
    f.db.close();
  });
});

function insertHandoff(
  f: Fixture,
  id: string,
  agentId: string,
  startedAt: Date,
  endedAt: Date | null,
  orderId: string | null = f.orderId,
): void {
  f.db
    .prepare(
      `INSERT INTO handoffs (id, customer_id, order_id, agent_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, f.customerId, orderId, agentId, startedAt.toISOString(), endedAt?.toISOString() ?? null);
}

describe('the closure records what was decided', () => {
  it('is idempotent, and returns the first closure rather than rewriting it', () => {
    const f = fixture();
    settledMoneyRequest(f, 'approved', 'REQ-AGAIN');
    const first = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'first@example.com',
      now: TEST_NOW,
    });
    const second = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'second@example.com',
      now: TEST_NOW,
    });

    expect(second.id).toBe(first.id);
    expect(second.closedBy).toBe('first@example.com');
    f.db.close();
  });

  it('writes an audit event naming the decision it closed on', () => {
    const f = fixture();
    settledMoneyRequest(f, 'partial_refund', 'REQ-AUDIT');
    closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    const events = f.db
      .prepare("SELECT detail FROM audit_events WHERE kind = 'chat_closed'")
      .all() as { detail: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toContain('partial_refund');
    f.db.close();
  });
});