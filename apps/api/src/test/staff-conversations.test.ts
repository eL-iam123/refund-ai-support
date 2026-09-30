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
      'Connecting you to a customer agent - please hold.',
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
    // The ask is anchor-neutral: a clarifying question is not a decision, so it
    // is stored against the customer, not the order the assistant had guessed.
    expect(row?.orderId).toBeNull();
    expect(row?.activeHandoff ?? null).toBeNull();

    // An agent opens the case file: the customer's own words, the question that
    // was asked, and no claim, because none was ever produced.
    const opened = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(session.customerId)}`,
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
});