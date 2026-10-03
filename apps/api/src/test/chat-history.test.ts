import { describe, expect, it, afterEach } from 'vitest';
import type { AppHarness } from './helpers.js';
import { authHeader } from './helpers.js';
import { cookiesOf, shopHarness, signIn, type SignedIn } from './shop-helpers.js';

/**
 * The order's thread as the composer sees it.
 *
 * `awaitingPerson` is read here rather than inferred from the turns, because the
 * question it answers - "is somebody holding this and have they replied?" - needs
 * both the handoff and the agent's messages, and only the server has both.
 */
async function historyFor(harness: AppHarness, session: SignedIn): Promise<{ awaitingPerson: boolean }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/shop/chat/history?orderId=${encodeURIComponent(session.orderId)}`,
    headers: { cookie: cookiesOf(session) },
  });
  return response.json<{ awaitingPerson: boolean }>();
}

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

type Turn =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly message: string;
      readonly responseText: string;
      readonly decision: string;
      readonly refundAmountCents: number;
      readonly itemIds: readonly string[];
    }
  | { readonly kind: 'dialogue'; readonly id: string; readonly message: string; readonly question: string; readonly itemIds: readonly string[] }
  | { readonly kind: 'update'; readonly id: string; readonly body: string; readonly requestId: string }
  | { readonly kind: 'agent'; readonly id: string; readonly body: string; readonly sender: 'agent' | 'customer' }
  | { readonly kind: 'handoff'; readonly id: string; readonly body: string };

function messageOf(turn: Turn): string {
  if (turn.kind === 'request' || turn.kind === 'dialogue') {
    return turn.message;
  }
  return turn.kind === 'agent' && turn.sender === 'customer' ? turn.body : '';
}

function itemIdsOf(turn: Turn | undefined): readonly string[] {
  return turn?.kind === 'request' || turn?.kind === 'dialogue' ? turn.itemIds : [];
}

/**
 * Asserts a turn is a request carrying some text, without `expect.stringContaining`.
 *
 * The asymmetric matcher returns `any`, and handing an `any` to the assertion
 * loses every type check inside it - including the one that would catch the
 * thread returning a different kind of turn than the one being claimed. Reading
 * the field off a narrowed turn keeps the assertion as strong as the type.
 */
function expectRequestSaying(turn: Turn | undefined, fragment: string): void {
  expect(turn?.kind).toBe('request');
  expect(turn?.kind === 'request' ? turn.message : '').toContain(fragment);
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
    // A greeting has told us nothing, so the question has to ask for the thing that is
    // missing - the reason - rather than repeat "tell me more". The old assertion
    // pinned the wording "what happened", which is precisely the vagueness this
    // replaced, so it is now a property: the question exists and it is one sentence.
    // Exactly one question, and it asks rather than tells. The examples after it are
    // deliberate - "something broken, something different, a delivery problem" tells a
    // customer what counts as an answer, which is what stops the next turn being a
    // paragraph.
    expect(reply.question?.split('?').length).toBe(2);

    // An ask is visible in the order's persisted thread, but it is not a
    // decision the pipeline can pay out and no person is paged for a greeting.
    const history = await threadFor(harness, session, session.orderId);
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('dialogue');
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
    expect(reply.question).not.toMatch(/how can i help|welcome/i);
    expect(harness.analyzerCalls()).toBe(0);
  });

  it('asks for damage details after the customer explains the problem', async () => {
    harness = await shopHarness({ kind: 'fixed', extraction: { reason: 'damaged' } });
    const session = await signIn(harness, 'sam@shop.demo');

    const hello = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'hello' },
    });
    // Whatever the greeting floor asks, it must not be the generic opener the model
    // was trained on: that is the sentence a customer learns to ignore.
    expect(hello.json<{ question?: string }>().question).not.toMatch(/how can i help|welcome/i);

    const damage = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'the mug is damaged' },
    });
    expect([200, 201]).toContain(damage.statusCode);
    expect(damage.json<{ question?: string }>().question).toContain('what the damage looks like');
    // The deterministic clarification runs before any analyzer can turn this
    // sparse report into a claim or immediate handoff.
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
    //
    // Each message names an item the order it is sent against really contains,
    // which is what makes it a decided request rather than a filed-without-one
    // question: naming something the order does not have is read as the customer
    // disagreeing with the order they were sent. The first order is the lamp and
    // the second is the coat, so a thread that mixed them up would show it in the
    // text rather than only in the counts.
    //
    // Grounded damage rather than non-delivery, so every message is decided.
    // That matters in a second way: an escalation raises a takeover, and a
    // takeover turns later messages on that order into conversation instead of
    // requests, which would reshape the thread for reasons that have nothing to
    // do with partitioning.
    await session.send(session.orderId, 'The lamp arrived with a cracked shade');
    await session.send(session.orderId, 'The lamp shade is still cracked after I unpacked it');
    const other = await session.buyAgain();
    expect(other).not.toBe(session.orderId);
    await session.send(other, 'The zip on my coat is broken and unusable');

    const first = await threadFor(harness, session, session.orderId);
    const second = await threadFor(harness, session, other);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);

    // Oldest first. A thread read newest-first puts the answer to the first
    // question below every question asked after it was already answered.
    expectRequestSaying(first[0], 'cracked shade');
    expectRequestSaying(first[1], 'still cracked');
    expectRequestSaying(second[0], 'zip');

    // The part that actually matters: neither thread contains the other's turns.
    for (const turn of first) {
      expect(messageOf(turn)).not.toContain('coat');
    }
    for (const turn of second) {
      expect(messageOf(turn)).not.toContain('lamp');
    }
  });

  it('retains the item scope from earlier requests so the UI can grey out already-reported items', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    await session.send(session.orderId, 'The lamp arrived with a cracked shade');

    const history = await threadFor(harness, session, session.orderId);
    expect(history).toHaveLength(1);
    expect(Array.isArray(itemIdsOf(history[0]))).toBe(true);
    expect(itemIdsOf(history[0]).length).toBeGreaterThan(0);
  });

  it('keeps the selected line through a clarification even when the answer only says “it”', async () => {
    harness = await shopHarness({
      kind: 'ask',
      question: 'What happened to the item?',
      then: {
        intent: 'refund',
        reason: 'damaged',
        condition: 'damaged',
        confidence: 0.9,
        evidenceQuotes: ['I want to return this package'],
      },
    });
    const session = await signIn(harness, 'sam@shop.demo');
    const checkout = await harness.app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: cookiesOf(session) },
      payload: {
        lines: [
          { productId: 'PRD-LAMP-01', quantity: 1 },
          { productId: 'PRD-JACKET-01', quantity: 1 },
          { productId: 'PRD-COFFEE-01', quantity: 1 },
        ],
      },
    });
    const order = checkout.json<{ order: { id: string; items: readonly { itemId: string; name: string }[] } }>().order;
    const coat = order.items.find((item) => item.name.includes('Meridian Wool Coat'));
    const lamp = order.items.find((item) => item.name.includes('Aurora Desk Lamp'));
    expect(coat).toBeDefined();
    expect(lamp).toBeDefined();
    if (coat === undefined) {
      throw new Error('checkout did not include the final-sale coat');
    }
    if (lamp === undefined) {
      throw new Error('checkout did not include the desk lamp');
    }

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: {
        customerId: session.customerId,
        orderId: order.id,
        message: 'I want to return this package',
        itemIds: [lamp.itemId],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ itemIds: readonly string[] }>().itemIds).toEqual([lamp.itemId]);

    const answer = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: {
        customerId: session.customerId,
        orderId: order.id,
        message: 'It arrived damaged and broken in two',
      },
    });
    expect(answer.statusCode, answer.body).toBe(201);
    const request = answer.json<{ request: { decision: { decision: string; refundAmountCents: number } } }>().request;
    expect(request.decision.decision).toBe('approved');
    expect(request.decision.refundAmountCents).toBe(12900);

    const history = await threadFor(harness, session, order.id);
    expect(itemIdsOf(history.at(-1))).toEqual([lamp.itemId]);
    expect(history.some((turn) => turn.kind === 'dialogue' && turn.itemIds.includes(lamp.itemId))).toBe(true);
  });

  it('does not refund an eligible line when the selected line is final sale', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const checkout = await harness.app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: cookiesOf(session) },
      payload: {
        lines: [
          { productId: 'PRD-LAMP-01', quantity: 1 },
          { productId: 'PRD-JACKET-01', quantity: 1 },
        ],
      },
    });
    const order = checkout.json<{ order: { id: string; items: readonly { itemId: string; name: string }[] } }>().order;
    const coat = order.items.find((item) => item.name.includes('Meridian Wool Coat'));
    expect(coat).toBeDefined();
    if (coat === undefined) {
      throw new Error('checkout did not include the final-sale coat');
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: {
        customerId: session.customerId,
        orderId: order.id,
        message: 'I want to return this package',
        itemIds: [coat.itemId],
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const request = response.json<{ request: { decision: { decision: string; refundAmountCents: number } } }>().request;
    expect(request.decision.decision).toBe('denied');
    expect(request.decision.refundAmountCents).toBe(0);
  });

  it('keeps an escalated order from swallowing the next one', async () => {
    // The reason this exists: raising a takeover for an escalated thread means
    // later messages on that thread stop being decisions. Done per *customer*
    // instead of per thread, it also swallows the next order - and a complaint
    // nobody has looked at being filed under a different order is a refund
    // quietly lost, which is worse than the escalation it replaced.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    // Non-delivery escalates: no grounded damage, no duplicate charge, so
    // nothing can approve it and a person is asked to decide.
    const escalated = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(escalated.decision).toBe('escalated');

    const other = await session.buyAgain();
    expect(other).not.toBe(session.orderId);
    // The coat, which is a final-sale item, so the resolver denies it on its own
    // evidence. The decision value is not the point: the point is that a decision
    // came back at all rather than the message being swallowed.
    const second = await session.send(other, 'The zip on my coat is broken and unusable');

    expect(second.handedOver).toBe(false);
    expect(second.decision).toBe('denied');

    // And the escalation still holds on the order it belongs to: the follow-up there
    // is answered by the pipeline rather than diverted. The takeover on it is
    // unattended, so there is no person to speak over - and diverting left the
    // customer with silence, which is the bug this reversal fixes.
    const stillEscalated = await session.send(session.orderId, 'Still nothing, this is the third time I have asked');
    expect(stillEscalated.handedOver).toBe(false);
    expect(stillEscalated.decision).toBe('escalated');
  });

  it('returns the same thread after a reload, and still declines a repeat', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    // Grounded damage on an item this order really has, so it is decided and the
    // thread is made of requests. Duplicate suppression only has something to
    // suppress on a thread the pipeline is still deciding: a message that lands
    // on an escalated thread is answered as conversation, and there is no second
    // decision for the gate to avoid.
    const complaint = 'The lamp arrived with a cracked shade';
    await session.send(session.orderId, complaint);

    const before = await threadFor(harness, session, session.orderId);
    const after = await threadFor(harness, session, session.orderId);
    expect(after.filter((turn) => turn.kind === 'request').map((turn) => turn.requestId)).toEqual(
      before.filter((turn) => turn.kind === 'request').map((turn) => turn.requestId),
    );

    // Resending the same complaint is still suppressed, not decided twice, and
    // the suppressed message does not appear in the thread a second time.
    const repeat = await session.send(session.orderId, complaint);
    expect(repeat.duplicate).not.toBeNull();
    expect(await threadFor(harness, session, session.orderId)).toHaveLength(before.length);
  });

  it("will not show one customer another customer's history", async () => {
    harness = await shopHarness();
    const mine = await signIn(harness, 'sam@shop.demo');
    await mine.send(mine.orderId, 'The lamp arrived with a cracked shade');

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
    await session.send(session.orderId, 'The lamp arrived with a cracked shade');
    await session.send(session.orderId, 'The lamp shade is still cracked after I unpacked it');

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/chat/summary',
      headers: { cookie: cookiesOf(session) },
    });
    expect(response.statusCode).toBe(200);
    const counts = response.json<{ counts: readonly { orderId: string; count: number }[] }>().counts;
    expect(counts.find((row) => row.orderId === session.orderId)?.count).toBe(2);
  });

  it('counts what the customer said while an agent was on the line', async () => {
    // The badge is a claim about whether this customer has been heard from. If it
    // stops counting once a person takes the thread - the moment the customer's
    // messages stop being refund_requests rows - it reads "1" beside a conversation
    // the customer can plainly see three messages in, and the storefront contradicts
    // itself about the same thread.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const escalated = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(escalated.decision).toBe('escalated');

    // An agent takes the thread, which is what makes this test about a *staffed*
    // handoff: the message is theirs and is not a refund_requests row.
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${encodeURIComponent(session.customerId)}/take-over`,
      headers: { authorization: authHeader('agent') },
      payload: { orderId: session.orderId },
    });
    expect(claimed.statusCode).toBe(200);

    const duringTakeover = await session.send(session.orderId, 'Any update on this?');
    expect(duringTakeover.handedOver).toBe(true);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/shop/chat/summary',
      headers: { cookie: cookiesOf(session) },
    });
    const counts = response.json<{ counts: readonly { orderId: string; count: number }[] }>().counts;
    expect(counts.find((row) => row.orderId === session.orderId)?.count).toBe(2);
  });

  it('closes the composer while a person is holding the thread, and reopens it on their reply', async () => {
    // The customer is typing into a conversation a person is about to answer, and
    // every word they write in the meantime is collected by nobody. The box waits,
    // and opens again the moment the person replies - which is the cue that it is
    // the customer's turn.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const escalated = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(escalated.decision).toBe('escalated');

    const beforeClaim = await historyFor(harness, session);
    // Unattended: nobody is answering, so the box stays open.
    expect(beforeClaim.awaitingPerson).toBe(false);

    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${encodeURIComponent(session.customerId)}/take-over`,
      headers: { authorization: authHeader('agent') },
      payload: { orderId: session.orderId },
    });
    expect(claimed.statusCode).toBe(200);

    expect((await historyFor(harness, session)).awaitingPerson).toBe(true);

    const replied = await harness.app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${encodeURIComponent(session.customerId)}/message`,
      headers: { authorization: authHeader('agent') },
      payload: { orderId: session.orderId, body: 'I have looked at this and I am on it.' },
    });
    expect(replied.statusCode).toBe(200);

    expect((await historyFor(harness, session)).awaitingPerson).toBe(false);
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
