import { afterEach, describe, expect, it } from 'vitest';
import type { AppHarness } from './helpers.js';
import { appHarness, authHeader, TEST_NOW } from './helpers.js';
import { seedShop } from '../shop/seed.js';
import { cookiesOf, signIn, type SignedIn } from './shop-helpers.js';

/**
 * The live takeover console.
 *
 * This is the agreement between the automatic assistant and a person, tested
 * end to end over the real routes: the assistant leaves a thread mid-clarify,
 * an agent picks it up, the customer's next message stops reaching the pipeline
 * and starts reaching people, the agent's reply lands in the same thread the
 * assistant was using, and hand-back reconnects the pipeline where it was.
 *
 * The race guard is the load-bearing assertion: two agents taking the same
 * customer over is treated the way any other concurrent write to one customer
 * is - the second one loses.
 */

interface ThreadTurn {
  readonly kind: string;
  readonly id?: string;
  readonly sender?: string;
  readonly body?: string;
  readonly question?: string;
  readonly message?: string;
}

let harness: AppHarness | null = null;

afterEach(() => {
  harness = null;
});

function customerThread(h: AppHarness, session: SignedIn, orderId: string): Promise<readonly ThreadTurn[]> {
  return h.app
    .inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`,
      headers: { cookie: cookiesOf(session) },
    })
    .then((response) => response.json<{ turns: readonly ThreadTurn[] }>().turns);
}

const agent = () => authHeader('agent');

describe('the live takeover console', () => {
  it('routes a customer message to a person while a takeover is live, and back to the pipeline after hand-back', async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
    const app = harness.app;
    const session = await signIn(harness, 'sam@shop.demo');
    await session.send(session.orderId, 'The charger never arrived and I want my money back');

    // Take over the conversation. The same route refuses a second agent: this
    // is the race the guard exists to make impossible.
    const takeover = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: agent() },
      payload: { orderId: session.orderId },
    });
    expect(takeover.statusCode).toBe(200);
    const { handoff } = takeover.json<{ handoff: { id: string; agentId: string } }>();
    expect(handoff.agentId).toBe('test-staff');

    const secondAgent = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: agent() },
      payload: { orderId: session.orderId },
    });
    expect(secondAgent.statusCode).toBe(409);
    expect(secondAgent.json<{ error: string }>().error).toBe('handoff_already_active');

    // The customer's next message is answered by a person, not the pipeline.
    const routed = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'Hello? Are you there?' },
    });
    if (routed.statusCode !== 201) {
      console.error('routed failed:', routed.statusCode, routed.body);
    }
    expect(routed.statusCode).toBe(201);
    expect(routed.json()).toMatchObject({ received: true, agentConnected: true });
    expect(routed.json<{ message: { sender: string; body: string } }>().message).toMatchObject({
      sender: 'customer',
      body: 'Hello? Are you there?',
    });

    // The agent replies over the same thread the assistant was using.
    const reply = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/message`,
      headers: { authorization: agent() },
      payload: { body: '  You are through to me - I have the order in front of me.  ' },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json<{ message: { sender: string } }>().message.sender).toBe('agent');

    // The customer sees the notice, their routed message, and the agent's reply.
    const during = await customerThread(harness, session, session.orderId);
    expect(during.filter((turn) => turn.kind === 'handoff').map((turn) => turn.body)).toEqual([
      'A customer agent has joined this conversation.',
    ]);
    const routedShown = during.filter((turn) => turn.kind === 'agent' && turn.sender === 'customer');
    expect(routedShown.filter((turn) => turn.body === 'Hello? Are you there?')).toHaveLength(1);
    expect(
      during.filter((turn) => turn.kind === 'agent' && turn.sender === 'agent').map((turn) => turn.body),
    ).toEqual(['You are through to me - I have the order in front of me.']);

    // Taking the same customer over twice is impossible: this is the race the
    // guard exists to make impossible. The "no one on the line" message case is
    // asserted after hand-back below.

    // Hand back, and the pipeline answers again: the answer to the routed
    // exchange never enters the assistant's transcript, so its next message is
    // no richer than a stranger's - and a decision comes back.
    const handBack = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/hand-back`,
      headers: { authorization: agent() },
    });
    expect(handBack.statusCode).toBe(200);
    expect(handBack.json<{ ended: { id: string } }>().ended.id).toBe(handoff.id);

    // With the thread handed back, no one is on the line, so neither verb.
    const idling = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/hand-back`,
      headers: { authorization: agent() },
    });
    expect(idling.statusCode).toBe(409);

    const orphaned = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/message`,
      headers: { authorization: agent() },
      payload: { body: 'who?' },
    });
    expect(orphaned.statusCode).toBe(409);

    const resumed = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'The charger never arrived' },
    });
    expect(resumed.statusCode).toBe(201);
    const decided = resumed.json<{ request?: { decision: { decision: string } }; received?: boolean }>();
    expect(decided.received).toBeUndefined();
    expect(decided.request?.decision.decision).toBeDefined();

    // The takeover row is closed, so the conversation is back on the live
    // list as an ordinary AI thread.
    const back = await app.inject({
      method: 'GET',
      url: '/api/staff/conversations',
      headers: { authorization: agent() },
    });
    const row = back
      .json<{ conversations: readonly { customerId: string; activeHandoff: unknown }[] }>()
      .conversations.find((candidate) => candidate.customerId === session.customerId);
    expect(row?.activeHandoff ?? null).toBeNull();
  });

  it('shows a carrying conversation briefly, for the agent who is on it, and hides nothing the customer said', async () => {
    harness = await appHarness({ kind: 'ask', question: 'Please provide your order number', then: {} });
    seedShop(harness.db, TEST_NOW);
    const app = harness.app;
    const session = await signIn(harness, 'sam@shop.demo');

    // The customer is mid-clarify: the assistant asked an order-number demand
    // the pipeline had already resolved, so the guard replaced it.
    const first = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'It just never arrived, this is awful' },
    });
    expect(first.statusCode).toBe(200);
    const asked = first.json<{ question?: string }>();
    expect(asked.question).toBe(
      'Just to make sure I have understood you - could you tell me a bit more about what happened with the order and what you would like me to do?',
    );

    // The conversation is on the live list with no agent attached.
    const list = await app.inject({ method: 'GET', url: '/api/staff/conversations', headers: { authorization: agent() } });
    expect(list.statusCode).toBe(200);
    const row = list
      .json<{
        conversations: readonly {
          customerId: string;
          customerName: string;
          orderId: string | null;
          activeHandoff: unknown;
        }[];
      }>()
      .conversations.find((candidate) => candidate.customerId === session.customerId);
    expect(row?.customerName).toBe('Sam Okonkwo');
    // The row is anchored to the order the customer is actually talking about,
    // because that is the thread the transcript lives in: the next message reads
    // this question back as context, and the answer inherits the item scope the
    // customer had selected. What makes it not-a-case is everything below - no
    // request row, no claim, no handoff - not a missing order.
    expect(row?.orderId).toBe(session.orderId);
    expect(row?.activeHandoff ?? null).toBeNull();

    // An agent opens the case file: the customer's own words, the question that
    // was asked, and no claim, because none was ever produced.
    const opened = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(session.customerId)}&orderId=${encodeURIComponent(session.orderId)}`,
      headers: { authorization: agent() },
    });
    expect(opened.statusCode).toBe(200);
    const { thread, brief } = opened.json<{
      thread: readonly ThreadTurn[];
      brief: {
        state: string;
        whatTheySaid: readonly { text: string }[];
        dialogue: readonly { question: string; answer: string }[];
        claim: unknown;
        riskFlags: readonly unknown[];
      };
    }>();
    expect(thread.filter((turn) => turn.kind === 'dialogue')).toHaveLength(1);
    expect(brief.state).toBe('ai');
    expect(brief.whatTheySaid.map((line) => line.text)).toEqual([
      'It just never arrived, this is awful',
    ]);
    expect(brief.dialogue).toEqual([
      {
        question: 'Just to make sure I have understood you - could you tell me a bit more about what happened with the order and what you would like me to do?',
        answer: 'It just never arrived, this is awful',
      },
    ]);
    expect(brief.claim).toBeNull();
    expect(brief.riskFlags).toEqual([]);
  });

  it('lets a person take over an escalation that raised its own takeover', async () => {
    // An escalated thread raises a takeover on its own, and a takeover already in
    // place is exactly what `startHandoff` refuses to duplicate. Without this
    // the customer who escalated automatically could never be helped by a human
    // - the automatic takeover would lock the staff out of the very thread it
    // exists to get them to, and 409 would read as "someone is already on it".
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
    const app = harness.app;
    const session = await signIn(harness, 'sam@shop.demo');

    // Non-delivery escalates: nothing can approve it, so a person is asked.
    const escalated = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(escalated.decision).toBe('escalated');

    // The customer is already talking to "someone": the row exists before any
    // agent has opened the case.
    const beforeClaim = await app.inject({
      method: 'GET',
      url: '/api/staff/conversations',
      headers: { authorization: agent() },
    });
    const listedBefore = beforeClaim
      .json<{
        conversations: readonly {
          customerId: string;
          activeHandoff: { agentId: string; unattended: boolean } | null;
        }[];
      }>()
      .conversations.find((row) => row.customerId === session.customerId);
    expect(listedBefore?.activeHandoff?.agentId).toBe('awaiting-agent');
    // The console must be able to tell "waiting for a person" from "a colleague
    // has taken over"; both are `handed_off`, and only this flag separates them.
    expect(listedBefore?.activeHandoff?.unattended).toBe(true);

    const claim = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: agent() },
      payload: { orderId: session.orderId },
    });
    expect(claim.statusCode).toBe(200);
    const { handoff } = claim.json<{ handoff: { id: string; agentId: string } }>();
    expect(handoff.agentId).toBe('test-staff');

    // Claiming it did not open a second takeover, it filled in the existing one,
    // so the race guard is still the race guard: the next agent still loses.
    const secondAgent = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: authHeader('agent', 'another-staff') },
      payload: { orderId: session.orderId },
    });
    expect(secondAgent.statusCode).toBe(409);
    expect(secondAgent.json<{ error: string }>().error).toBe('handoff_already_active');

    // And the case file now names a person rather than a placeholder.
    const opened = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(session.customerId)}&orderId=${encodeURIComponent(session.orderId)}`,
      headers: { authorization: agent() },
    });
    const brief = opened.json<{ brief: { state: string; agentId: string | null; unattended: boolean } }>().brief;
    expect(brief.agentId).toBe('test-staff');
    expect(brief.unattended).toBe(false);
    expect(brief.state).not.toBe('ai');
  });

  it('does not fail a second order escalation when another order already has an unattended takeover', async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
    const session = await signIn(harness, 'sam@shop.demo');

    const first = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(first.decision).toBe('escalated');

    const checkout = await harness.app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: cookiesOf(session) },
      payload: { lines: [{ productId: 'PRD-MUG-01', quantity: 1 }] },
    });
    expect(checkout.statusCode).toBe(201);
    const secondOrderId = checkout.json<{ order: { id: string } }>().order.id;
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: {
        customerId: session.customerId,
        orderId: secondOrderId,
        message: 'The mug never arrived and I want my money back.',
      },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json<{ request: { decision: { decision: string } } }>().request.decision.decision).toBe('escalated');
  });

  it('briefs a person two agents cannot race for: the second takeover loses', async () => {
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
    const app = harness.app;
    const session = await signIn(harness, 'sam@shop.demo');
    await session.send(session.orderId, 'The charger never arrived and I want my money back');

    await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: agent() },
      payload: { orderId: session.orderId },
    });
    const other = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${session.customerId}/take-over`,
      headers: { authorization: authHeader('agent', 'another-staff') },
      payload: { orderId: session.orderId },
    });
    expect(other.statusCode).toBe(409);

    const opened = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(session.customerId)}&orderId=${encodeURIComponent(session.orderId)}`,
      headers: { authorization: agent() },
    });
    const brief = opened.json<{
      brief: { state: string; agentId: string | null; handoffReason: string | null };
    }>().brief;
    expect(brief.state).toBe('handed_off');
    expect(brief.agentId).toBe('test-staff');
    expect(brief.handoffReason).toContain('stepped aside');
  });

  it('leaves an unattended takeover to a person: the assistant does not answer in their place', async () => {
    // An escalation raises a takeover owned by the awaiting-agent slot, not by a
    // named agent. The customer can keep talking, and what they write has to reach
    // staff - but the model must not answer them. A reply written while nobody has
    // claimed the thread is the business speaking over a person who is on their
    // way, and once an agent claims it their message would contradict what the
    // customer was just told.
    harness = await appHarness();
    seedShop(harness.db, TEST_NOW);
    const app = harness.app;
    const session = await signIn(harness, 'sam@shop.demo');

    // Non-delivery escalates, raising the unattended takeover.
    const escalated = await session.send(session.orderId, 'The charger never arrived and I want my money back');
    expect(escalated.decision).toBe('escalated');

    // The case file says nobody holds it yet, so the console shows the claim verb
    // rather than a reply box that the message route would then refuse.
    const openedBeforeClaim = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(session.customerId)}&orderId=${encodeURIComponent(session.orderId)}`,
      headers: { authorization: agent() },
    });
    const beforeBrief = openedBeforeClaim.json<{ brief: { state: string; unattended: boolean } }>().brief;
    expect(beforeBrief.state).toBe('handed_off');
    expect(beforeBrief.unattended).toBe(true);

    const routed = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'I would like to return this item.' },
    });
    expect(routed.statusCode).toBe(201);
    // No human has claimed it, so `agentConnected` is false rather than the
    // optimistic true - the storefront uses it to decide whether to keep the
    // customer's message box open or to show that a person is still to come.
    expect(routed.json()).toMatchObject({ received: true, agentConnected: false, aiResponse: null });
    expect(routed.json<{ message: { sender: string; body: string } }>().message).toMatchObject({
      sender: 'customer',
      body: 'I would like to return this item.',
    });

    // The message is durably recorded and announced to staff, so nobody has to
    // poll the console to discover a customer is waiting.
    const announced = harness.hubEvents().filter((observation) => observation.channel === 'staff');
    expect(
      announced.some(
        (observation) =>
          observation.event.type === 'customer.message' &&
          (observation.event as { readonly message: { readonly body: string } }).message.body ===
            'I would like to return this item.',
      ),
    ).toBe(true);

    // And nothing was written on the customer's behalf.
    const during = await customerThread(harness, session, session.orderId);
    expect(during.filter((turn) => turn.kind === 'agent' && turn.sender === 'agent')).toHaveLength(0);
    expect(during.filter((turn) => turn.kind === 'handoff').map((turn) => turn.body)).toEqual([
      'Your request is waiting for a person to review it. The assistant will not reply on their behalf.',
    ]);
  });
});