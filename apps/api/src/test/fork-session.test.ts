import { afterEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
import {
  endHandoff,
  forkForMessage,
  forkScopeForHandoff,
  liveClaimedForks,
  startHandoff,
  takeoverForEscalated,
  type ActiveHandoff,
} from '../db/handoffs.js';
import { TEST_NOW, type AppHarness, authHeader } from './helpers.js';
import { cookiesOf, shopHarness, signIn, type SignedIn } from './shop-helpers.js';

/**
 * One escalation, split off so it can be talked about.
 *
 * An escalation used to take the customer's whole voice: every later message
 * on any thread landed on the agent thread, and the composer locked
 * everywhere. A fork is the same escalation with a recorded scope - the
 * decided case's order and item ids - so follow-ups about that case reach the
 * person on it while everything else keeps flowing through the pipeline.
 *
 * The unit half pins the scope math: claim wins, eligible fills an empty
 * claim, empty either way means no recorded scope, and anything without a
 * person attached is not a fork. The route half pins the behaviour: the
 * fork's own follow-ups land with the person, other items start their own
 * cases, status questions get status answers, and other orders stay open.
 */

const LAMP_PRODUCT = 'PRD-LAMP-01';
const MUG_PRODUCT = 'PRD-MUG-01';
const AGENT = 'agent-1';

interface Fixture {
  readonly db: Db;
  readonly customerId: string;
  readonly orderId: string;
  readonly lampItemId: string;
  readonly mugItemId: string;
}

function fixture(): Fixture {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(db, { email: 'fork@shop.test', password: 'a-good-password', name: 'Fork Tester' }, TEST_NOW);
  const order = checkout(
    db,
    user.customerId,
    [
      { productId: LAMP_PRODUCT, quantity: 1 },
      { productId: MUG_PRODUCT, quantity: 1 },
    ],
    TEST_NOW,
  );
  const lamp = order.items.find((line) => line.productId === LAMP_PRODUCT);
  const mug = order.items.find((line) => line.productId === MUG_PRODUCT);
  if (lamp === undefined || mug === undefined) {
    throw new Error('checkout did not return both lines');
  }
  return { db, customerId: user.customerId, orderId: order.id, lampItemId: lamp.itemId, mugItemId: mug.itemId };
}

/** A stored escalated request, so each test is about forks and not about what escalates. */
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
    customerName: 'Fork Tester',
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

function claimedFork(f: Fixture, requestId: string): ActiveHandoff {
  return startHandoff(f.db, {
    customerId: f.customerId,
    orderId: f.orderId,
    agentId: AGENT,
    now: TEST_NOW,
    requestId,
  });
}

describe('fork scope', () => {
  it('prefers the decided claim over the eligible items', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-CLAIM', [f.lampItemId], [f.lampItemId, f.mugItemId]));
    const fork = claimedFork(f, 'REQ-CLAIM');

    expect(forkScopeForHandoff(f.db, fork)).toEqual({ orderId: f.orderId, itemIds: [f.lampItemId] });
    f.db.close();
  });

  it('falls back to the eligible items when the claim is empty', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-ELIGIBLE', [], [f.lampItemId, f.mugItemId]));
    const fork = claimedFork(f, 'REQ-ELIGIBLE');

    expect(forkScopeForHandoff(f.db, fork)).toEqual({ orderId: f.orderId, itemIds: [f.lampItemId, f.mugItemId] });
    f.db.close();
  });

  it('has no scope when the case named no items either way', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-BARE', [], []));
    const fork = claimedFork(f, 'REQ-BARE');

    expect(forkScopeForHandoff(f.db, fork)).toBeNull();
    f.db.close();
  });

  it('has no scope without a decided case behind it', () => {
    const f = fixture();
    const manual = startHandoff(f.db, {
      customerId: f.customerId,
      orderId: f.orderId,
      agentId: AGENT,
      now: TEST_NOW,
      requestId: null,
    });

    expect(forkScopeForHandoff(f.db, manual)).toBeNull();
    f.db.close();
  });
});

describe('fork matching', () => {
  it('routes the forked case back to its person and nothing else', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-MATCH', [f.lampItemId], [f.lampItemId, f.mugItemId]));
    const fork = claimedFork(f, 'REQ-MATCH');

    // The fork's own follow-up, with and without naming the item again.
    expect(forkForMessage(f.db, f.customerId, { orderId: f.orderId, itemIds: [f.lampItemId] })?.handoff.id).toBe(
      fork.id,
    );
    expect(forkForMessage(f.db, f.customerId, { orderId: f.orderId, itemIds: [] })?.handoff.id).toBe(fork.id);
    // Another item on the same order starts its own case.
    expect(forkForMessage(f.db, f.customerId, { orderId: f.orderId, itemIds: [f.mugItemId] })).toBeNull();
    // Another order is never the fork's business.
    expect(forkForMessage(f.db, f.customerId, { orderId: 'ORD-ELSEWHERE', itemIds: [f.lampItemId] })).toBeNull();
    // No resolution at all routes nowhere.
    expect(forkForMessage(f.db, f.customerId, { orderId: null, itemIds: [] })).toBeNull();
    f.db.close();
  });

  it('ignores takeovers with nobody attached and takeovers that ended', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-WAITING', [f.lampItemId], [f.lampItemId]));
    const waiting = takeoverForEscalated(f.db, f.customerId, f.orderId, TEST_NOW);
    expect(waiting?.unattended).toBe(true);

    // The automatic marker is not a fork: nobody is on it yet.
    expect(liveClaimedForks(f.db, f.customerId)).toEqual([]);
    expect(forkForMessage(f.db, f.customerId, { orderId: f.orderId, itemIds: [f.lampItemId] })).toBeNull();

    // Claiming turns the marker into the fork; ending it resolves to nothing.
    endHandoff(f.db, f.customerId, TEST_NOW);
    const claimed = claimedFork(f, 'REQ-WAITING');
    expect(liveClaimedForks(f.db, f.customerId).map((entry) => entry.handoff.id)).toEqual([claimed.id]);
    endHandoff(f.db, f.customerId, TEST_NOW);
    expect(liveClaimedForks(f.db, f.customerId)).toEqual([]);
    f.db.close();
  });

  it('skips a claimed takeover that predates forks', () => {
    const f = fixture();
    insertRequest(f.db, escalatedRow(f.customerId, f.orderId, 'REQ-LEGACY', [f.lampItemId], [f.lampItemId]));
    // Claimed by a person, but bound to no case: the old whole-thread reach.
    startHandoff(f.db, { customerId: f.customerId, orderId: f.orderId, agentId: AGENT, now: TEST_NOW, requestId: null });

    expect(liveClaimedForks(f.db, f.customerId).map((entry) => entry.scope)).toEqual([null]);
    expect(forkForMessage(f.db, f.customerId, { orderId: f.orderId, itemIds: [f.lampItemId] })).toBeNull();
    f.db.close();
  });
});

let harness: AppHarness | null = null;

afterEach(() => {
  harness = null;
});

const agent = () => authHeader('agent');

interface ForkSetup {
  readonly session: SignedIn;
  readonly multiOrderId: string;
  readonly otherOrderId: string;
  readonly lampItemId: string;
  readonly mugItemId: string;
  readonly forkId: string;
}

/** A claimed fork on a two-line order, reached the way a customer reaches one. */
async function setupFork(): Promise<ForkSetup> {
  const current = await shopHarness();
  harness = current;
  const session = await signIn(current, 'sam@shop.demo');
  const otherOrderId = await session.buyAgain();

  const bought = await current.app.inject({
    method: 'POST',
    url: '/api/shop/checkout',
    headers: { cookie: cookiesOf(session) },
    payload: {
      lines: [
        { productId: LAMP_PRODUCT, quantity: 1 },
        { productId: MUG_PRODUCT, quantity: 1 },
      ],
    },
  });
  expect(bought.statusCode).toBe(201);
  const boughtOrder = bought.json<{ order: { id: string; items: readonly { itemId: string; productId: string }[] } }>().order;
  const lamp = boughtOrder.items.find((line) => line.productId === LAMP_PRODUCT);
  const mug = boughtOrder.items.find((line) => line.productId === MUG_PRODUCT);
  if (lamp === undefined || mug === undefined) {
    throw new Error('checkout did not return both lines');
  }

  insertRequest(
    current.db,
    escalatedRow(session.customerId, boughtOrder.id, 'REQ-FORK-1', [lamp.itemId], [lamp.itemId, mug.itemId]),
  );

  // Any message on the thread raises the automatic takeover for the case...
  const noticed = await current.app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    headers: { cookie: cookiesOf(session) },
    payload: { customerId: session.customerId, orderId: boughtOrder.id, message: 'thanks' },
  });
  expect([200, 201]).toContain(noticed.statusCode);

  // ...and a person claiming it turns the marker into the fork.
  const takeover = await current.app.inject({
    method: 'POST',
    url: `/api/staff/conversations/${session.customerId}/take-over`,
    headers: { authorization: agent() },
    payload: { orderId: boughtOrder.id },
  });
  expect(takeover.statusCode).toBe(200);
  const { handoff } = takeover.json<{ handoff: { id: string; agentId: string } }>();

  return { session, multiOrderId: boughtOrder.id, otherOrderId, lampItemId: lamp.itemId, mugItemId: mug.itemId, forkId: handoff.id };
}

function customerHistory(
  h: AppHarness,
  session: SignedIn,
  orderId: string,
): Promise<{ awaitingPerson: boolean; turns: readonly { kind: string }[] }> {
  return h.app
    .inject({
      method: 'GET',
      url: `/api/shop/chat/history?orderId=${encodeURIComponent(orderId)}`,
      headers: { cookie: cookiesOf(session) },
    })
    .then((response) => response.json<{ awaitingPerson: boolean; turns: readonly { kind: string }[] }>());
}

describe('the forked thread', () => {
  it('routes the forked case to its person and keeps other items on the pipeline', async () => {
    const setup = await setupFork();
    const app = (harness as AppHarness).app;

    // The fork's own follow-up lands with the person, not the resolver.
    const followUp = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(setup.session) },
      payload: {
        customerId: setup.session.customerId,
        orderId: setup.multiOrderId,
        message: 'No, refund the lamp',
        itemIds: [setup.lampItemId],
      },
    });
    expect(followUp.statusCode).toBe(201);
    expect(followUp.json()).toMatchObject({ received: true, agentConnected: true });

    // Another item on the same order starts its own case instead.
    const otherItem = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(setup.session) },
      payload: {
        customerId: setup.session.customerId,
        orderId: setup.multiOrderId,
        message: 'The Harbour Stoneware Mug arrived cracked too and I want my money back',
        itemIds: [setup.mugItemId],
      },
    });
    expect(otherItem.statusCode).toBe(201);
    const otherBody = otherItem.json<{ received?: boolean; request?: unknown; question?: string }>();
    expect(otherBody.received).toBeUndefined();
    expect(otherBody.request !== undefined || otherBody.question !== undefined).toBe(true);

    // Another order is untouched by the fork entirely: the pipeline decides.
    const elsewhere = await setup.session.send(setup.otherOrderId, 'The charger never arrived and I want my money back');
    expect(elsewhere.handedOver).toBe(false);
    expect(elsewhere.decision).not.toBeNull();
  });

  it('answers status questions during a fork instead of filing them', async () => {
    const setup = await setupFork();
    const app = (harness as AppHarness).app;

    const status = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(setup.session) },
      payload: { customerId: setup.session.customerId, orderId: setup.multiOrderId, message: 'where is my order?' },
    });
    expect(status.statusCode).toBe(201);
    const body = status.json<{ received?: boolean; shopAnswer?: unknown }>();
    expect(body.received).toBeUndefined();
    expect(body.shopAnswer).toBeDefined();
  });

  it('locks only the forked thread, leaving other orders open', async () => {
    const setup = await setupFork();
    const current = harness as AppHarness;

    expect((await customerHistory(current, setup.session, setup.multiOrderId)).awaitingPerson).toBe(true);
    expect((await customerHistory(current, setup.session, setup.otherOrderId)).awaitingPerson).toBe(false);
  });

  it('lists the fork with its case, takes follow-ups, and hides strangers', async () => {
    const setup = await setupFork();
    const current = harness as AppHarness;
    const app = current.app;

    const listed = await app.inject({
      method: 'GET',
      url: '/api/shop/cases',
      headers: { cookie: cookiesOf(setup.session) },
    });
    expect(listed.statusCode).toBe(200);
    const forks = listed.json<{
      forks: readonly {
        handoffId: string;
        orderId: string | null;
        items: readonly { id: string; name: string }[];
        unanswered: boolean;
      }[];
    }>().forks;
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({
      handoffId: setup.forkId,
      orderId: setup.multiOrderId,
      unanswered: true,
    });
    expect(forks[0]?.items.map((item) => item.name)).toEqual(['Aurora Desk Lamp']);

    const written = await app.inject({
      method: 'POST',
      url: `/api/shop/cases/${setup.forkId}/message`,
      headers: { cookie: cookiesOf(setup.session) },
      payload: { message: 'The lamp is still broken' },
    });
    expect(written.statusCode).toBe(201);

    const read = await app.inject({
      method: 'GET',
      url: `/api/shop/cases/${setup.forkId}/messages`,
      headers: { cookie: cookiesOf(setup.session) },
    });
    expect(read.statusCode).toBe(200);
    const messages = read.json<{ messages: readonly { sender: string; body: string }[] }>().messages;
    expect(messages.filter((message) => message.body === 'The lamp is still broken')).toHaveLength(1);

    // A stranger's id guess reads as not found, and other customers learn nothing.
    const stranger = await signIn(current, 'priya@shop.demo');
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/shop/cases/${setup.forkId}/messages`,
      headers: { cookie: cookiesOf(stranger) },
    });
    expect(hidden.statusCode).toBe(404);
    const refused = await app.inject({
      method: 'POST',
      url: `/api/shop/cases/${setup.forkId}/message`,
      headers: { cookie: cookiesOf(stranger) },
      payload: { message: 'hello?' },
    });
    expect(refused.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/shop/cases',
          headers: { cookie: cookiesOf(stranger) },
        })
      ).json<{ forks: readonly unknown[] }>().forks,
    ).toEqual([]);
  });

  it('keeps an unclaimed escalation out of the fork box', async () => {
    const setup = await setupFork();
    const current = harness as AppHarness;
    const app = current.app;

    // Hand the fork back first: the single-live invariant means no second
    // takeover can exist while one is claimed, so the waiting escalation
    // below is only reachable with no fork live.
    const handBack = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${setup.session.customerId}/hand-back`,
      headers: { authorization: agent() },
    });
    expect(handBack.statusCode).toBe(200);

    // Escalate the other order but leave its takeover unclaimed.
    insertRequest(current.db, escalatedRow(setup.session.customerId, setup.otherOrderId, 'REQ-FORK-WAITING', [], []));
    const noticed = await app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: cookiesOf(setup.session) },
      payload: { customerId: setup.session.customerId, orderId: setup.otherOrderId, message: 'thanks' },
    });
    expect([200, 201]).toContain(noticed.statusCode);

    const queue = await app.inject({
      method: 'GET',
      url: '/api/staff/conversations',
      headers: { authorization: agent() },
    });
    const waiting = queue
      .json<{
        conversations: readonly {
          orderId: string | null;
          activeHandoff: { id: string; unattended: boolean } | null;
        }[];
      }>()
      .conversations.find((row) => row.orderId === setup.otherOrderId)?.activeHandoff;
    if (waiting === undefined || waiting === null || !waiting.unattended) {
      throw new Error('expected an unattended takeover on the other order');
    }

    // The panel lists forks with a person, not escalations still waiting: the
    // handed-back fork is gone and the waiting one never appears.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/shop/cases',
      headers: { cookie: cookiesOf(setup.session) },
    });
    expect(listed.json<{ forks: readonly unknown[] }>().forks).toEqual([]);

    // And the fork box refuses a thread with nobody on it.
    const refused = await app.inject({
      method: 'POST',
      url: `/api/shop/cases/${waiting.id}/message`,
      headers: { cookie: cookiesOf(setup.session) },
      payload: { message: 'hello?' },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('shows the agent which case a row is, and reads one fork on request', async () => {
    const setup = await setupFork();
    const current = harness as AppHarness;
    const app = current.app;

    const queue = await app.inject({
      method: 'GET',
      url: '/api/staff/conversations',
      headers: { authorization: agent() },
    });
    const row = queue
      .json<{
        conversations: readonly {
          orderId: string | null;
          forkScope: { orderId: string; itemIds: readonly string[] } | null;
        }[];
      }>()
      .conversations.find((candidate) => candidate.orderId === setup.multiOrderId);
    expect(row?.forkScope).toEqual({ orderId: setup.multiOrderId, itemIds: [setup.lampItemId] });

    // The agent's reply lands on the live fork, where the customer reads it.
    const reply = await app.inject({
      method: 'POST',
      url: `/api/staff/conversations/${setup.session.customerId}/message`,
      headers: { authorization: agent() },
      payload: { body: 'I have the lamp case in front of me' },
    });
    expect(reply.statusCode).toBe(200);

    const thread = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(setup.session.customerId)}&orderId=${encodeURIComponent(setup.multiOrderId)}&handoffId=${encodeURIComponent(setup.forkId)}`,
      headers: { authorization: agent() },
    });
    expect(thread.statusCode).toBe(200);
    const bodies = thread
      .json<{ thread: readonly { kind: string; sender?: string; body?: string }[] }>()
      .thread.filter((turn) => turn.kind === 'agent')
      .map((turn) => turn.body);
    expect(bodies).toContain('I have the lamp case in front of me');

    // A handoff id from another customer reads as not found.
    const stranger = await signIn(current, 'dana@shop.demo');
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/staff/conversation?customerId=${encodeURIComponent(stranger.customerId)}&handoffId=${encodeURIComponent(setup.forkId)}`,
      headers: { authorization: agent() },
    });
    expect(wrong.statusCode).toBe(404);
  });
});
