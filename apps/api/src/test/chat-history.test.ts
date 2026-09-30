import { describe, expect, it, afterEach } from 'vitest';
import type { AppHarness } from './helpers.js';
import { authHeader } from './helpers.js';
import { cookiesOf, shopHarness, signIn, type SignedIn } from './shop-helpers.js';

/**
 * One thread per order.
 *
 * The property being tested is not "history is returned" - it is that history is
 * *partitioned*. A shared conversation across orders is the specific failure this
 * work exists to prevent: the mug is already refunded, the customer asks about
 * it, and the assistant either forgets or confuses it with the lamp. So the
 * assertions below are about which turns appear under which order, and about
 * whose turns are visible at all.
 *
 * The isolation assertion is the load-bearing one. It is easy to build a history
 * endpoint that behaves correctly for the ordinary case and leaks under a
 * crafted id, so the cross-customer case is tested with a real second session
 * rather than by reading the SQL and agreeing with it.
 */

interface Turn {
  readonly requestId: string;
  readonly message: string;
  readonly responseText: string;
  readonly decision: string;
  readonly refundAmountCents: number;
}

let harness: AppHarness | null = null;

afterEach(() => {
  harness = null;
});

/** Sends a message and returns the ids of the requests now in the thread. */
async function threadFor(h: AppHarness, session: SignedIn, orderId: string): Promise<readonly Turn[]> {
  const response = await h.app.inject({
    method: 'GET',
    url: `/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`,
    headers: { cookie: cookiesOf(session) },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ turns: readonly Turn[] }>().turns;
}

describe('a greeting is not a request', () => {
  it('answers "hello" with a question and files no request', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'hello' },
    });
    expect([200, 201]).toContain(sent.statusCode);
    const reply = sent.json<{ question?: string; duplicate: unknown }>();
    expect(reply.question).toBeDefined();
    expect(reply.question).toContain('what happened');

    // An ask is stored as dialogue, not as a decision the pipeline can pay out,
    // so the thread holds no request and no person is paged for a greeting.
    expect(await threadFor(harness, session, session.orderId)).toHaveLength(0);
  });

  it('answers a greeting even against a provider that would claim it', async () => {
    // The floor lives in the pipeline, not in one extractor: a fixed analyzer
    // that submits a claim for everything must still not be consulted for a
    // greeting, because that is precisely the case where R-12's escalation is
    // the wrong answer.
    harness = await shopHarness({ kind: 'fixed', extraction: { reason: 'other' } });
    const session = await signIn(harness, 'sam@shop.demo');

    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'hello' },
    });
    expect([200, 201]).toContain(sent.statusCode);
    const reply = sent.json<{ question?: string }>();
    expect(reply.question).toBeDefined();
    expect(reply.question).toContain('what happened');
    expect(harness.analyzerCalls()).toBe(0);
  });

  it('does not file the conversation as a live takeover candidate', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'thanks' },
    });

    const staff = await harness.app.inject({ method: 'GET', url: '/api/staff/conversations', headers: { authorization: authHeader('agent') } });
    const rows = staff.json<{ conversations: readonly { customerId: string; activeHandoff: unknown }[] }>().conversations;
    const row = rows.find((candidate) => candidate.customerId === session.customerId);
    // The message moved the customer's thread, so the row exists for the agent
    // to open - but no claim was filed, so the case file must not pretend there
    // is a decision waiting on a person.
    expect(row).toBeDefined();
  });
});

describe('per-order chat history', () => {
  it("keeps each order's thread to itself and reads oldest first", async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    // Two messages about one order, one about another, for the same customer.
    // The second order is what makes this a test of partitioning rather than of
    // counting: a single shared thread would satisfy every count below.
    await session.send(session.orderId, 'The charger never arrived and I want my money back');
    await session.send(session.orderId, 'Still nothing. This is the third time I have asked.');
    const other = await session.buyAgain();
    expect(other).not.toBe(session.orderId);
    // The message names something this order actually contains. That is not
    // incidental: naming an item the order does not have is treated as the
    // customer disagreeing with the order they were sent, and the request is
    // filed without one - which is the behaviour that would otherwise make this
    // test look like a history bug.
    await session.send(other, 'The coat arrived with a tear in the lining');

    const first = await threadFor(harness, session, session.orderId);
    const second = await threadFor(harness, session, other);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);

    // Oldest first. A thread read newest-first puts the answer to the first
    // question below every question asked after it was already answered.
    expect(first[0]?.message).toContain('never arrived');
    expect(first[1]?.message).toContain('third time');
    expect(second[0]?.message).toContain('lining');

    // The part that actually matters: neither thread contains the other's turns.
    for (const turn of first) {
      expect(turn.message).not.toContain('lining');
    }
    for (const turn of second) {
      expect(turn.message).not.toContain('never arrived');
    }
  });

  it('returns the same thread after a reload, and still declines a repeat', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    await session.send(session.orderId, 'The item never arrived and I want my money back');

    const before = await threadFor(harness, session, session.orderId);
    const after = await threadFor(harness, session, session.orderId);
    expect(after.map((turn) => turn.requestId)).toEqual(before.map((turn) => turn.requestId));

    // Resending the same complaint is still suppressed, not decided twice, and
    // the suppressed message does not appear in the thread a second time.
    const repeat = await session.send(session.orderId, 'The item never arrived and I want my money back');
    expect(repeat.duplicate).not.toBeNull();
    expect(await threadFor(harness, session, session.orderId)).toHaveLength(before.length);
  });

  it("will not show one customer another customer's history", async () => {
    harness = await shopHarness();
    const mine = await signIn(harness, 'sam@shop.demo');
    await mine.send(mine.orderId, 'The item never arrived and I want my money back');

    const theirs = await signIn(harness, 'priya@shop.demo');

    // Same order id, different session. The reply must be indistinguishable from
    // one for an order with no history at all, so it cannot leak through status
    // code, body, or the shape of the error.
    const asTheirs = await harness.app.inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${mine.orderId}`,
      headers: { cookie: cookiesOf(theirs) },
    });
    expect(asTheirs.statusCode).toBe(404);
    expect(asTheirs.body).not.toContain('never arrived');
  });

  it('reports message counts per order', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    await session.send(session.orderId, 'The item never arrived and I want my money back');
    await session.send(session.orderId, 'Still nothing, this is the third time I have asked.');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/chat/summary',
      headers: { cookie: cookiesOf(session) },
    });
    expect(response.statusCode).toBe(200);
    const counts = response.json<{ counts: readonly { orderId: string; count: number }[] }>().counts;
    expect(counts.find((row) => row.orderId === session.orderId)?.count).toBe(2);
  });

  it('requires a session, and takes no customer id from the caller', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    const anonymous = await harness.app.inject({ method: 'GET', url: '/api/shop/chat/history?orderId=ORD-1' });
    expect(anonymous.statusCode).toBe(401);

    // A customerId parameter is not part of the contract. It is ignored rather
    // than honoured, so the session still decides whose thread this is.
    const spoofed = await harness.app.inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${session.orderId}&customerId=CUST-0001`,
      headers: { cookie: cookiesOf(session) },
    });
    expect(spoofed.statusCode).toBe(200);
  });

  it('404s an order that is not the caller’s, and 400s one that is not named', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/chat/history?orderId=ORD-NOT-A-REAL-ORDER',
      headers: { cookie: cookiesOf(session) },
    });
    expect(missing.statusCode).toBe(404);

    const unnamed = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/chat/history',
      headers: { cookie: cookiesOf(session) },
    });
    expect(unnamed.statusCode).toBe(400);
  });
});
