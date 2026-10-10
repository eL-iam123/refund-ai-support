import { describe, expect, it } from 'vitest';
import { shopHarness, signIn } from './shop-helpers.js';

/**
 * Follow-ups on an open case are journaled, not answered with parking text.
 *
 * The reported complaint: every "thanks" while a person owned the case got
 * "A person is still reviewing your request - nothing further is needed"
 * pasted into the thread - noise the customer never asked for, restated on
 * every turn. Now the follow-up lands on the case's handoff thread where the
 * agent reads it, the thread itself stays quiet, and no policy runs on it.
 */

async function escalatedSession() {
  const harness = await shopHarness({ kind: 'unavailable', message: '503 from the provider' });
  const session = await signIn(harness, 'sam@shop.demo');
  const send = (message: string) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: session.cookie },
      payload: { customerId: session.customerId, orderId: session.orderId, message },
    });
  // A claim no model can read escalates, which raises the unattended marker
  // the parked follow-up journals onto.
  const first = await send('The mug arrived with a crack through the handle and I want a refund.');
  return { harness, session, send, first };
}

describe('a follow-up on an open case', () => {
  it('is journaled to the case instead of answered with parking text', async () => {
    const { harness, session, send, first } = await escalatedSession();
    try {
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json<{ request?: { decision?: { decision?: string } } }>().request?.decision?.decision).toBe(
        'escalated',
      );

      const followup = await send('thanks for the update, much appreciated');
      expect(followup.statusCode, followup.body).toBe(200);
      const body = followup.json<{ received?: boolean; agentConnected?: boolean; status?: string }>();
      // Received onto the thread, not answered in it: no parking paragraph,
      // no new decision row, no policy run.
      expect(body.received).toBe(true);
      expect(body).not.toHaveProperty('status');
      expect(body.agentConnected).toBe(false);

      const requests = harness.db
        .prepare('SELECT COUNT(*) AS n FROM refund_requests')
        .get() as { n: number };
      expect(requests.n).toBe(1);

      const audit = harness.db
        .prepare("SELECT detail FROM audit_events WHERE kind = 'followup_on_open_case'")
        .all() as { detail: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]?.detail).toContain('thanks for the update');

      const thread = harness.db
        .prepare(
          `SELECT m.body FROM agent_messages m
             JOIN handoffs h ON h.id = m.handoff_id
            WHERE h.customer_id = ? AND m.sender = ?
            ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
        )
        .get(session.customerId, 'customer') as { body: string } | undefined;
      expect(thread?.body).toBe('thanks for the update, much appreciated');
    } finally {
      await harness.app.close();
      harness.db.close();
    }
  });

  it('still runs a message that states a new claim through the pipeline', async () => {
    const { harness, send, first } = await escalatedSession();
    try {
      expect(first.statusCode, first.body).toBe(201);
      // A stated fault is a new case wearing a familiar thread, not a
      // follow-up: it must decide, not journal.
      const fresh = await send('actually the lamp arrived shattered too');
      expect(fresh.statusCode, fresh.body).toBe(201);
      expect(
        fresh.json<{ request?: { decision?: { decision?: string } } }>().request?.decision?.decision,
      ).toBe('escalated');
      const requests = harness.db
        .prepare('SELECT COUNT(*) AS n FROM refund_requests')
        .get() as { n: number };
      expect(requests.n).toBe(2);
    } finally {
      await harness.app.close();
      harness.db.close();
    }
  });
});
