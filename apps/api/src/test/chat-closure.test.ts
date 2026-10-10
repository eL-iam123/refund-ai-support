import { describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { TEST_NOW } from './helpers.js';
import {
  ChatNotFinalizedError,
  chatClosureForThread,
  closeFinalizedChat,
  finalizedRequestId,
  isChatClosed,
} from '../db/chatClosures.js';
import { ESCALATION_AGENT } from '../db/handoffs.js';
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
  it.each(['exchange', 'store_credit'] as const)('closes a %s thread its holder closes mid-conversation', (decision) => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, decision, `REQ-ALT-${decision}`, 0));
    insertHandoff(f, 'HAND-LIVE', 'agent@example.com', TEST_NOW, null);

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

  it('still refuses an escalated thread while nobody has handled it', () => {
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'escalated', 'REQ-STILL-OPEN', 0));

    // No handoff at all: a person still owes this customer an answer.
    expect(finalizedRequestId(f.db, f.customerId, f.orderId)).toBeNull();

    // The automatic marker is not handling either: nobody is on it.
    insertHandoff(f, 'HAND-WAITING', ESCALATION_AGENT, TEST_NOW, null);
    expect(finalizedRequestId(f.db, f.customerId, f.orderId)).toBeNull();
    f.db.close();
  });

  it('closes an escalated thread its holder closes mid-conversation', () => {
    // A person holding the case is handling it, ended handoff or not:
    // closing ends their live takeover too, and requiring a hand-back first
    // would add a round trip without adding any protection.
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'escalated', 'REQ-HELD', 0));
    insertHandoff(f, 'HAND-LIVE', 'agent@example.com', TEST_NOW, null);

    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe('escalated');
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(true);
    const live = f.db
      .prepare('SELECT COUNT(*) AS n FROM handoffs WHERE id = ? AND ended_at IS NULL')
      .get('HAND-LIVE') as { n: number };
    expect(live.n).toBe(0);
    f.db.close();
  });

  it('closes an escalated thread once a person has handled it', () => {
    // The escalation was the person being owed an answer; an ended handoff is
    // the answer having been given. Without this, a case a person resolved
    // could never be closed, and every resolved escalation stayed open forever.
    const f = fixture();
    insertRequest(f.db, requestRow(f, 'escalated', 'REQ-HANDLED', 0));
    insertHandoff(f, 'HAND-DONE', 'agent@example.com', TEST_NOW, TEST_NOW);

    const closure = closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });

    expect(closure.finalState).toBe('escalated');
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(true);
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
describe('a closure finalises lines, not threads', () => {
  function shopFixture(): Fixture {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(
      db,
      { email: 'lines@shop.test', password: 'a-good-password', name: 'Lines Tester' },
      TEST_NOW,
    );
    const order = checkout(
      db,
      user.customerId,
      [
        { productId: 'PRD-LAMP-01', quantity: 1 },
        { productId: 'PRD-MUG-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    return { db, customerId: user.customerId, orderId: order.id };
  }

  function lineIds(f: Fixture): string[] {
    const rows = f.db
      .prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY id')
      .all(f.orderId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  function deniedLineRequest(f: Fixture, requestId: string, itemIds: readonly string[]): void {
    insertRequest(
      f.db,
      requestRow(f, 'denied', requestId, 0),
    );
    // The fixture row carries no scope; the denial below speaks for these lines.
    f.db
      .prepare('UPDATE refund_requests SET claim_item_ids_json = ?, eligible_item_ids_json = ? WHERE id = ?')
      .run(JSON.stringify(itemIds), JSON.stringify(itemIds), requestId);
  }

  function close(f: Fixture) {
    return closeFinalizedChat(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      closedBy: 'agent@example.com',
      now: TEST_NOW,
    });
  }

  it('leaves unreported lines reportable after a scoped case closes', () => {
    const f = shopFixture();
    const [first, second] = lineIds(f);
    if (first === undefined || second === undefined) {
      throw new Error('seed order needs two lines for this test');
    }
    deniedLineRequest(f, 'REQ-LINE-1', [first]);
    const closure = close(f);

    // The closure names the decided line, and the thread stays open for the other.
    expect([...(closure.closedItemIds ?? [])]).toEqual([first]);
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(false);
    f.db.close();
  });

  it('merges later decisions into the same closure row until every line is closed', () => {
    const f = shopFixture();
    const [first, second] = lineIds(f);
    if (first === undefined || second === undefined) {
      throw new Error('seed order needs two lines for this test');
    }
    deniedLineRequest(f, 'REQ-LINE-1', [first]);
    const before = close(f);
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(false);

    deniedLineRequest(f, 'REQ-LINE-2', [second]);
    const after = close(f);
    expect(after.id).toBe(before.id);
    expect([...(after.closedItemIds ?? [])].sort()).toEqual([first, second].sort());
    expect(after.requestId).toBe('REQ-LINE-2');
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(true);
    f.db.close();
  });

  it('reads a pre-line-scope row as fully closed', () => {
    const f = shopFixture();
    deniedLineRequest(f, 'REQ-LEGACY', lineIds(f));
    close(f);
    // A row from before line-scoping carries no line set.
    f.db.prepare('UPDATE chat_closures SET closed_item_ids_json = NULL').run();

    expect(chatClosureForThread(f.db, f.customerId, f.orderId)?.closedItemIds).toBeNull();
    expect(isChatClosed(f.db, f.customerId, f.orderId)).toBe(true);
    f.db.close();
  });

  it('re-closing with nothing new is idempotent', () => {
    const f = shopFixture();
    const [first] = lineIds(f);
    if (first === undefined) {
      throw new Error('seed order needs a line for this test');
    }
    deniedLineRequest(f, 'REQ-LINE-1', [first]);
    const before = close(f);
    const again = close(f);
    expect(again.id).toBe(before.id);
    expect(again.closedAt).toBe(before.closedAt);
    f.db.close();
  });
});
