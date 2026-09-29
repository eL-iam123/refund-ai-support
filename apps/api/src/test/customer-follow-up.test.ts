import { describe, expect, it } from 'vitest';
import type { AppHarness } from './helpers.js';
import { cookiesOf, shopHarness, signIn, type SignedIn } from './shop-helpers.js';
import { authHeader } from './helpers.js';
import { findRequestById } from '../db/requestRepository.js';

/**
 * Telling the customer what a person decided.
 *
 * The property that matters is not that a message is written - it is that the
 * message never claims more than the ledger did. A follow-up that says "your
 * refund has been sent" before anyone pressed settle is worse than no follow-up
 * at all, because the customer stops chasing and nobody ever pays them.
 *
 * So the tests assert the wording at each stage rather than merely that a row
 * appeared, and they check the customer sees it in their own thread and nobody
 * else does.
 */

/**
 * The harness, held in a module variable so each test can build one in a single
 * line. `live()` narrows it: every test assigns before reading, and a test that
 * forgot would otherwise be a null-dereference halfway through an assertion
 * rather than an immediate, named failure.
 */
let current: AppHarness | null = null;

function live(): AppHarness {
  if (current === null) {
    throw new Error('the test did not create a harness');
  }
  return current;
}

const ADMIN = { authorization: authHeader('admin', 'reviewer-1') };

/** The bodies of every follow-up in this customer's thread for an order. */
async function updatesFor(session: SignedIn, orderId: string): Promise<readonly string[]> {
  const response = await live().app.inject({
    method: 'GET',
    url: `/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`,
    headers: { cookie: cookiesOf(session) },
  });
  expect(response.statusCode).toBe(200);
  const turns = response.json<{
    turns: readonly { kind: string; body?: string; message?: string }[];
  }>().turns;
  return turns.filter((turn) => turn.kind === 'update').map((turn) => turn.body ?? '');
}

async function escalatedRequest(session: SignedIn, orderId: string): Promise<string> {
  const sent = await session.send(orderId, 'The charger never arrived and I want my money back');
  expect(sent.decision).toBe('escalated');
  const row = live().db
    .prepare('SELECT id FROM refund_requests WHERE order_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(orderId) as { id: string };
  return row.id;
}

describe('admin decisions are reported to the customer', () => {
  it('says a person approved, and does not say the money has moved', async () => {
    current = await shopHarness();
    const session = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(session, session.orderId);

    const response = await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'approved', note: 'Confirmed with the courier' },
    });
    expect(response.statusCode).toBe(200);

    const bodies = await updatesFor(session, session.orderId);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? '';

    // The decision, and the fact that a person made it.
    expect(body).toMatch(/team has reviewed/i);
    expect(body).toMatch(/approved/i);
    // Approved, not paid. This is the line that must not be crossed early.
    expect(body).not.toMatch(/has been sent|has been paid|we have refunded/i);
  });

  it('says the money was sent only after it was settled', async () => {
    current = await shopHarness();
    const session = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(session, session.orderId);

    await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'approved', note: 'Confirmed with the courier' },
    });

    // Settling needs the refund row the override authorised.
    const refund = live().db
      .prepare('SELECT id FROM refunds WHERE request_id = ?')
      .get(requestId) as { id: string };
    const settled = await live().app.inject({
      method: 'POST',
      url: `/api/refunds/${refund.id}/settle`,
      headers: ADMIN,
    });
    expect(settled.statusCode).toBe(200);

    const bodies = await updatesFor(session, session.orderId);
    expect(bodies).toHaveLength(2);
    const paid = bodies[1] ?? '';
    expect(paid).toMatch(/has been sent to your original payment method/i);
    // The amount comes from the ledger, and it is a real one.
    expect(paid).not.toMatch(/\$0\.00/);
  });

  it('says nothing is taken when a hold is released', async () => {
    current = await shopHarness();
    const session = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(session, session.orderId);

    await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'approved', note: 'Looks fine on paper' },
    });
    const refund = live().db
      .prepare('SELECT id FROM refunds WHERE request_id = ?')
      .get(requestId) as { id: string };

    const released = await live().app.inject({
      method: 'POST',
      url: `/api/refunds/${refund.id}/release`,
      headers: ADMIN,
      payload: { reason: 'Customer withdrew the claim' },
    });
    expect(released.statusCode).toBe(200);

    const bodies = await updatesFor(session, session.orderId);
    const last = bodies[bodies.length - 1] ?? '';
    expect(last).toMatch(/withdrawn/i);
    expect(last).toMatch(/nothing was taken/i);
    // Never a payment.
    expect(last).not.toMatch(/has been sent to your original/i);
  });

  it('puts the follow-up after the question it answers', async () => {
    current = await shopHarness();
    const session = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(session, session.orderId);

    await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'denied', note: 'Outside the 45-day window' },
    });

    const response = await live().app.inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${encodeURIComponent(session.orderId)}`,
      headers: { cookie: cookiesOf(session) },
    });
    const turns = response.json<{ turns: readonly { kind: string }[] }>().turns;
    const kinds = turns.map((turn) => turn.kind);
    // The question comes first, the answer after it. A thread that sorts a reply
    // before the message it replies to is a thread nobody can follow.
    expect(kinds.indexOf('request')).toBeLessThan(kinds.lastIndexOf('update'));
  });

  it('does not put one customer’s decision in another customer’s thread', async () => {
    current = await shopHarness();
    const mine = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(mine, mine.orderId);

    await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'approved', note: 'Confirmed with the courier' },
    });

    const theirs = await signIn(live(), 'priya@shop.demo');
    const asTheirs = await live().app.inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${encodeURIComponent(mine.orderId)}`,
      headers: { cookie: cookiesOf(theirs) },
    });
    expect(asTheirs.statusCode).toBe(404);
    expect(asTheirs.body).not.toMatch(/team has reviewed/i);
  });

  it('leaves the stored decision and the audit trail exactly as they were', async () => {
    current = await shopHarness();
    const session = await signIn(live(), 'sam@shop.demo');
    const requestId = await escalatedRequest(session, session.orderId);

    await live().app.inject({
      method: 'POST',
      url: `/api/requests/${requestId}/override`,
      headers: ADMIN,
      payload: { decision: 'approved', note: 'Confirmed with the courier' },
    });

    // The follow-up is a message, not a second decision. If telling the customer
    // changed what the system believes happened, the audit would be describing
    // the conversation rather than the money.
    const row = findRequestById(live().db, requestId);
    expect(row?.decision).toBe('approved');
    expect(row?.overriddenBy).toBe('reviewer-1');
    const events = live().db
      .prepare('SELECT kind FROM audit_events WHERE request_id = ?')
      .all(requestId) as readonly { kind: string }[];
    expect(events.map((event) => event.kind)).toContain('human_override');
  });
});
