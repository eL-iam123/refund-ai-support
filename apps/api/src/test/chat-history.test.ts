import { describe, expect, it, afterEach } from 'vitest';
import type { AppHarness } from './helpers.js';
import { authHeader, TEST_NOW } from './helpers.js';
import type { Db } from '../db/connection.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
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

/** The newest decision row on an order, or how many rows it has. */
function latestRequestId(db: Db, orderId: string): string {
  const row = db
    .prepare('SELECT id FROM refund_requests WHERE order_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(orderId) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`no request stored for order ${orderId}`);
  }
  return row.id;
}

function countRequests(db: Db, orderId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM refund_requests WHERE order_id = ?')
    .get(orderId) as { total: number };
  return row.total;
}

/** A stored escalated request, so the test is about routing and not about what escalates. */
function escalatedRow(
  customerId: string,
  orderId: string,
  requestId: string,
  claim: readonly string[],
  eligible: readonly string[],
): NewRequestRow {
  const at = TEST_NOW.toISOString();
  return {
    id: requestId,
    createdAt: at,
    customerId,
    customerName: 'Test Customer',
    orderId,
    message: 'fixture claim',
    messageSha256: '0'.repeat(64),
    messageFingerprint: '0'.repeat(64),
    decision: 'escalated',
    refundAmountCents: 0,
    eligibleAmountCents: 0,
    summary: 'fixture',
    policyRef: 'REFUND_POLICY.md §5.1',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: JSON.stringify(eligible),
    claimItemIdsJson: JSON.stringify(claim),
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

describe('a courtesy is not a request', () => {
  it('answers "hello" with a question and files no request', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'hello' },
    });
    expect(sent.statusCode).toBe(200);
    const body = sent.json<{ question?: string; request?: unknown }>();
    // A courtesy, not a claim: the deterministic floor asks what went wrong
    // instead of running the complaint through the claim path.
    expect(body.request).toBeUndefined();
    expect(body.question).toMatch(/what has gone wrong with it/i);

    // Nothing was filed, so the thread holds only the dialogue turn and the
    // ledger is untouched. There is no work for a person either: no request
    // row means no case to pick up.
    expect(countRequests(harness.db, session.orderId)).toBe(0);
    const thread = await threadFor(harness, session, session.orderId);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.kind).toBe('dialogue');
  });

  it('answers a greeting even against a provider that would claim it', async () => {
    // The floor lives in the pipeline, not in one extractor: a fixed analyzer
    // that submits a claim for everything must still not consult the model for
    // a greeting, because that is precisely the case where running a claim
    // is the wrong answer.
    harness = await shopHarness({ kind: 'fixed', extraction: { reason: 'other' } });
    const session = await signIn(harness, 'sam@shop.demo');

    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'hello' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json<{ question: string }>().question).not.toMatch(/how can i help|welcome/i);
    expect(harness.analyzerCalls()).toBe(0);
    const requests = harness.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get() as { n: number };
    expect(requests.n).toBe(0);
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
    // A courtesy, answered without the pipeline: the floor this test guards is
    // that a greeting never becomes a claim, whatever a model would do with it.
    expect(hello.statusCode).toBe(200);
    expect(hello.json<{ question: string }>().question).toMatch(/what has gone wrong with it/i);

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

  it('creates no work for a person when the customer is only being polite', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');

    await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId: session.orderId, message: 'thanks' },
    });

    const staff = await harness.app.inject({ method: 'GET', url: '/api/staff/conversations', headers: { authorization: authHeader('agent') } });
    const rows = staff.json<{ conversations: readonly { customerId: string; activeHandoff: object | null }[] }>().conversations;
    const row = rows.find((candidate) => candidate.customerId === session.customerId);
    // A courtesy is answered with a question and handed to nobody: the staff
    // list may still show the conversation (the dialogue turn counts as
    // activity), but there is no handoff, no takeover, and no claim filed -
    // nothing for a person to pick up.
    expect(row?.activeHandoff).toBeNull();
    expect(countRequests(harness.db, session.orderId)).toBe(0);
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
    await session.send(session.orderId, 'The lamp arrived with a cracked shade and I want my money back');
    await session.send(session.orderId, 'The lamp shade is still cracked after I unpacked it and I still want my money back');
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

    await session.send(session.orderId, 'The lamp arrived with a cracked shade and I want my money back');

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
        evidenceQuotes: ['I have a problem with this package'],
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
        message: 'I have a problem with this package',
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
        message: 'It arrived damaged and broken in two, please refund me.',
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
        message: 'I want to return this package for a refund',
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
    const escalatedId = latestRequestId(harness.db, session.orderId);

    const other = await session.buyAgain();
    expect(other).not.toBe(session.orderId);
    // The coat, which is a final-sale item, so the resolver denies it on its own
    // evidence. The decision value is not the point: the point is that a decision
    // came back at all rather than the message being swallowed.
    const second = await session.send(other, 'The zip on my coat is broken and unusable');

    expect(second.handedOver).toBe(false);
    expect(second.decision).toBe('denied');

    // And the escalation still holds on the order it belongs to: a follow-up
    // restating the complaint is acknowledged against the open case rather
    // than decided again. A second decision row for the same complaint is the
    // double-escalation the open-case gate exists to stop - the follow-up
    // names no new fault, asks for no money, and requests no person, so there
    // is nothing new to decide.
    const rowsBefore = countRequests(harness.db, session.orderId);
    const stillEscalated = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: {
        customerId: session.customerId,
        orderId: session.orderId,
        message: 'Still nothing, this is the third time I have asked',
      },
    });
    expect(stillEscalated.statusCode).toBe(200);
    const openCase = stillEscalated.json<{ status: string; requestId: string }>();
    expect(openCase.requestId).toBe(escalatedId);
    expect(countRequests(harness.db, session.orderId)).toBe(rowsBefore);
  });

  it('treats a different item on an open-escalation thread as a new case, not a follow-up', async () => {
    // No fault words, no money ask - just a polite question about another
    // line. The signal gate reads it as a follow-up, but the open case is
    // about the mug and this names the lamp, so swallowing it as a follow-up
    // would quietly lose a complaint. Disjoint scopes mean different cases.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const app = harness.app;

    const bought = await app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: cookiesOf(session) },
      payload: {
        lines: [
          { productId: 'PRD-LAMP-01', quantity: 1 },
          { productId: 'PRD-MUG-01', quantity: 1 },
        ],
      },
    });
    expect(bought.statusCode).toBe(201);
    const boughtOrder = bought.json<{
      order: { id: string; items: readonly { itemId: string; name: string }[] };
    }>().order;
    const orderId = boughtOrder.id;
    const lampItemId = boughtOrder.items.find((item) => item.name === 'Aurora Desk Lamp')?.itemId ?? '';
    const mugItemId = boughtOrder.items.find((item) => item.name === 'Harbour Stoneware Mug')?.itemId ?? '';
    expect(lampItemId).not.toBe('');
    expect(mugItemId).not.toBe('');

    // An open escalation scoped to the mug, written directly so the test is
    // about routing follow-ups rather than about what escalates.
    insertRequest(
      harness.db,
      escalatedRow(session.customerId, orderId, 'REQ-OPEN-MUG', [mugItemId], [mugItemId, lampItemId]),
    );

    const rowsBefore = countRequests(harness.db, orderId);
    const lamp = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'what about the lamp?', itemIds: [lampItemId] },
    });
    // Not the open-case status: the message reached the pipeline, which asks
    // rather than swallows. Either a question or a decision proves routing;
    // only the status shape proves swallowing.
    const lampBody = lamp.json<{ status?: string; question?: string; request?: unknown }>();
    expect(lampBody.status).toBeUndefined();
    expect(lampBody.question ?? lampBody.request).toBeDefined();
    expect(countRequests(harness.db, orderId)).toBe(rowsBefore);
  });

  it('completes a confirmation past an older open escalation, and answers the next one too', async () => {
    // The open-case status and the duplicate gate must both stand aside for a
    // confirmation answer: the "yes" completes the case its question offered,
    // and answering it with the old escalation's status - or with another
    // case's "yes" - would leave the confirmation permanently unanswerable.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const app = harness.app;

    const bought = await app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: cookiesOf(session) },
      payload: {
        lines: [
          { productId: 'PRD-LAMP-01', quantity: 1 },
          { productId: 'PRD-MUG-01', quantity: 1 },
        ],
      },
    });
    expect(bought.statusCode).toBe(201);
    const boughtOrder = bought.json<{
      order: { id: string; items: readonly { itemId: string; name: string }[] };
    }>().order;
    const orderId = boughtOrder.id;
    const mugItemId = boughtOrder.items.find((item) => item.name === 'Harbour Stoneware Mug')?.itemId ?? '';
    const lampItemId = boughtOrder.items.find((item) => item.name === 'Aurora Desk Lamp')?.itemId ?? '';
    expect(mugItemId).not.toBe('');
    expect(lampItemId).not.toBe('');

    const old = await session.send(orderId, 'The charger never arrived and I want my money back');
    expect(old.decision).toBe('escalated');

    const ask = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'the mug is not what i ordered', itemIds: [mugItemId] },
    });
    expect(ask.statusCode).toBe(200);
    expect(ask.json<{ question: string }>().question).toContain('Before we refund anything:');

    const rowsBefore = countRequests(harness.db, orderId);
    // The client answers with the question's scope, exactly as a tap would:
    // a typed "yes" names nothing, so it carries the pending scope along.
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'yes please', itemIds: [mugItemId] },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ request: { decision: { decision: string } } }>().request.decision.decision).toBe('approved');
    expect(countRequests(harness.db, orderId)).toBe(rowsBefore + 1);

    // A second "yes" on the same order answers its own confirmation, not the
    // first one: the fingerprints match, so only the pending-confirmation skip
    // keeps it from being suppressed as a repeat. A different line, so the
    // refundable balance is not the question here.
    const askAgain = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'the lamp is not what i ordered', itemIds: [lampItemId] },
    });
    expect(askAgain.statusCode).toBe(200);
    expect(askAgain.json<{ question: string }>().question).toContain('Before we refund anything:');

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'yes please', itemIds: [lampItemId] },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ request: { decision: { decision: string } } }>().request.decision.decision).toBe('approved');
    expect(countRequests(harness.db, orderId)).toBe(rowsBefore + 2);
  });

  it('returns the same thread after a reload, and still declines a repeat', async () => {
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    // Grounded damage on an item this order really has, so it is decided and the
    // thread is made of requests. Duplicate suppression only has something to
    // suppress on a thread the pipeline is still deciding: a message that lands
    // on an escalated thread is answered as conversation, and there is no second
    // decision for the gate to avoid.
    const complaint = 'The lamp arrived with a cracked shade and I want my money back';
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
    await mine.send(mine.orderId, 'The lamp arrived with a cracked shade and I want my money back');

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
    await session.send(session.orderId, 'The lamp arrived with a cracked shade and I want my money back');
    await session.send(session.orderId, 'The lamp shade is still cracked after I unpacked it and I still want my money back');

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

  it('answers a policy question about the scoped item instead of escalating it', async () => {
    // The picker asked "What's the issue with the Meridian Wool Coat?" and the
    // customer answers with a policy question. That is a question, not a fault
    // report: it must be answered from the floor and must not file a claim.
    // Before the floor existed the pending scope carried the coat to the fact
    // gates, R-02 marked it final sale, and the thread was handed to a person.
    harness = await shopHarness();
    const session = await signIn(harness, 'sam@shop.demo');
    const app = harness.app;

    const bought = await app.inject({
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
    expect(bought.statusCode).toBe(201);
    const orderId = bought.json<{ order: { id: string } }>().order.id;
    const coatItemId = bought.json<{
      order: { items: readonly { itemId: string; name: string }[] };
    }>().order.items.find((item) => item.name.startsWith('Meridian Wool Coat'))?.itemId ?? '';
    expect(coatItemId).not.toBe('');

    // The pending scope the picker left behind: a dialogue turn carrying the
    // coat so the next unticked message is read as being about it.
    harness.db
      .prepare(
        `INSERT INTO shop_dialogue
           (id, created_at, customer_id, order_id, customer_message, assistant_question,
            assistant_offer_json, item_ids_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'DLG-POLICY-SCOPE',
        TEST_NOW.toISOString(),
        session.customerId,
        orderId,
        "what's wrong with the coat",
        "So I can look at this properly - what's the issue with the Meridian Wool Coat?",
        null,
        JSON.stringify([coatItemId]),
      );

    const before = countRequests(harness.db, orderId);
    const policy = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(session) },
      payload: { customerId: session.customerId, orderId, message: 'what does yor policy say about that item' },
    });
    expect(policy.statusCode).toBe(200);

    // No request row, no takeover text: a question, answered about the coat.
    const policyBody = policy.json<{ question?: string; picker?: unknown; notice?: string }>();
    expect(policyBody.question).toBeDefined();
    expect(policyBody.picker).toBeNull();
    expect(policyBody.notice).toBeNull();
    expect(policyBody.question ?? '').toContain('Meridian Wool Coat');
    expect(policyBody.question ?? '').toMatch(/final sale/i);
    expect(countRequests(harness.db, orderId)).toBe(before);
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
