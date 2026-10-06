import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { findOrder } from '../db/orderRepository.js';
import { findCustomer } from '../db/sql.js';
import { identifyOrder, disputeCeiling } from '../retrieval/identifyOrder.js';
import { DEFAULT_ITEM_PICKER, itemPickerOffer } from '../retrieval/itemPicker.js';
import { runFactGates } from '../policy/gates.js';
import type { PolicyContext } from '../policy/types.js';
import type { CustomerRecord } from '../db/records.js';
import type { ItemPickerConfig } from '../config/env.js';
import { TEST_NOW } from './helpers.js';
import { shopHarness, signIn } from './shop-helpers.js';
import { insertRequest, type NewRequestRow } from '../db/requestRepository.js';
import type { Decision } from '@refund/shared';

interface Fixture {
  readonly db: Db;
  readonly customerId: string;
  readonly orderId: string;
  readonly lampItemId: string;
  readonly mugItemId: string;
}

/**
 * A real order bought through the storefront's own checkout, so the fixtures read
 * the same rows the pipeline would - including the item ids the picker offers.
 */
function fixture(email: string): Fixture {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  seedShop(db, TEST_NOW);
  const user = createUser(db, { email, password: 'a-good-password', name: 'Picker Tester' }, TEST_NOW);
  const order = checkout(
    db,
    user.customerId,
    [
      { productId: 'PRD-LAMP-01', quantity: 1 },
      { productId: 'PRD-MUG-01', quantity: 1 },
    ],
    TEST_NOW,
  );
  return {
    db,
    customerId: user.customerId,
    orderId: order.id,
    lampItemId: order.items.find((item) => item.name === LAMP)?.itemId ?? '',
    mugItemId: order.items.find((item) => item.name === MUG)?.itemId ?? '',
  };
}

function customerOf(f: Fixture): CustomerRecord {
  const customer = findCustomer(f.db, f.customerId, TEST_NOW);
  if (customer === null) {
    throw new Error('fixture customer missing');
  }
  return customer;
}

function contextFor(f: Fixture, orderId: string | null = f.orderId): PolicyContext {
  const order = orderId === null ? null : findOrder(f.db, f.customerId, orderId, TEST_NOW);
  return {
    db: f.db,
    customer: customerOf(f),
    order,
    duplicateSibling: null,
    injection: { detected: false, signals: [], obfuscationNoted: false },
    injectionAction: 'deny',
    extraction: null,
    grounding: null,
    subjectItem: null,
    eligibleItems: [],
    blockedItems: [],
    eligibleAmountCents: 0,
    orderTotalCents: order?.totalCents ?? 0,
  };
}

/**
 * The item picker, offered from inside the conversation.
 *
 * Two things are being asserted here, and the second matters more than the first.
 *
 * The first is the decision matrix: when to ask, and - just as important - the
 * long list of conditions under which to stay quiet. A picker that returns on
 * every turn is worse than no picker, so "withheld" is a first-class outcome and
 * gets as many assertions as "offered".
 *
 * The second is the trust invariant. Item scope is the dispute ceiling, which caps
 * what an approval can pay, so the question of *who* decides the scope is a
 * question about money. It is the customer's, always: the model nominates
 * candidates and the server may decline them, and nothing in this file - or in the
 * module under test - lets an id that came out of the model reach the ceiling.
 */

const LAMP = 'Aurora Desk Lamp'; // 12900
const MUG = 'Harbour Stoneware Mug'; // 2400

describe('when the picker is offered', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture('picker@shop.test');
  });

  /** The offer under the given conditions, so each test states one variable. */
  function offer(
    overrides: {
      readonly message?: string;
      readonly itemIds?: readonly string[];
      readonly injectionDetected?: boolean;
      readonly handoffActive?: boolean;
      readonly request?: { readonly candidates: readonly string[] } | null;
      readonly config?: Partial<ItemPickerConfig>;
      readonly terminalGates?: boolean;
      readonly orderId?: string | null;
    } = {},
  ) {
    const orderId = overrides.orderId === undefined ? f.orderId : overrides.orderId;
    const order = orderId === null ? null : findOrder(f.db, f.customerId, orderId, TEST_NOW);
    const identification = identifyOrder(
      f.db,
      customerOf(f),
      orderId,
      overrides.message ?? 'something in this delivery went wrong',
      TEST_NOW,
      overrides.itemIds ?? [],
    );
    const gates = runFactGates(contextFor(f, orderId), overrides.itemIds ?? []);
    return itemPickerOffer({
      db: f.db,
      customerId: f.customerId,
      order,
      identification,
      gates: { ...gates, terminal: overrides.terminalGates === true },
      injectionDetected: overrides.injectionDetected === true,
      handoffActive: overrides.handoffActive === true,
      request: overrides.request ?? null,
      config: { ...DEFAULT_ITEM_PICKER, ...overrides.config },
    });
  }

  it('offers when the customer described a problem without naming the item', () => {
    const result = offer();
    expect(result?.orderId).toBe(f.orderId);
    // Both lines are offered, and the basket is over the floor: choosing is worth
    // asking about when the choice can change what is paid.
    expect(result?.items.map((item) => item.name).sort()).toEqual([LAMP, MUG].sort());
    expect(result?.suggested).toEqual([]);
  });

  it('stays quiet when the message already names the item', () => {
    // "The lamp arrived cracked" is resolved. Asking which item, after they said,
    // reads as not having listened - the complaint `item-scope.test.ts` exists to
    // prevent is the mirror image of this one.
    expect(offer({ message: 'the lamp arrived cracked' })).toBeNull();
  });

  it('stays quiet when the customer has already ticked a line', () => {
    expect(offer({ itemIds: [f.mugItemId] })).toBeNull();
  });

  it('stays quiet on a single-line order, where there is nothing to choose', () => {
    const single = checkout(f.db, f.customerId, [{ productId: 'PRD-GUIDE-01', quantity: 1 }], TEST_NOW);
    expect(offer({ orderId: single.id })).toBeNull();
  });

  it('stays quiet below the floor, where choosing cannot change what is paid', () => {
    // Two small lines are not worth a question, and a picker with two buttons on it
    // is a form field in disguise.
    // $9 and $14: two ordinary lines with nothing special about them, so the only
    // reason to stay quiet is that there is not enough money at stake to ask about.
    const small = checkout(
      f.db,
      f.customerId,
      [
        { productId: 'PRD-PIN-01', quantity: 1 },
        { productId: 'PRD-NOTEBOOK-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    expect(small.totalCents).toBeLessThan(DEFAULT_ITEM_PICKER.minCents);
    expect(offer({ orderId: small.id })).toBeNull();
  });

  it('stays quiet on an injection signal', () => {
    // Asking for input on a message flagged as a policy-override attempt is
    // inviting the attack to be answered.
    expect(offer({ injectionDetected: true })).toBeNull();
  });

  it('stays quiet while a person is already engaged with the customer', () => {
    expect(offer({ handoffActive: true })).toBeNull();
  });

  it('stays quiet once the fact gates have ended the request', () => {
    expect(offer({ terminalGates: true })).toBeNull();
  });

  it('stays quiet when switched off', () => {
    expect(offer({ config: { enabled: false } })).toBeNull();
  });

  it('offers once, and never again for the same thread', () => {
    expect(offer()).not.toBeNull();

    // Recorded the way the orchestrator records it: an offer, with no scope on it.
    f.db
      .prepare(
        `INSERT INTO shop_dialogue
           (id, created_at, customer_id, order_id, customer_message, assistant_question,
            assistant_offer_json, item_ids_json)
         VALUES ('DLG-1', ?, ?, ?, 'something went wrong', 'Which item is this about?', ?, '[]')`,
      )
      .run(
        TEST_NOW.toISOString(),
        f.customerId,
        f.orderId,
        JSON.stringify({ orderId: f.orderId, items: [], suggested: [] }),
      );

    // The bound is the whole reason this is not a loop: a picker that returns on
    // every turn teaches people to stop using the assistant.
    expect(offer()).toBeNull();
  });

  it('offers lines with only an open escalation, and marks decided lines reported', () => {
    // The lamp has an escalated case still waiting on a person; the mug has a
    // denial. The lamp must stay choosing - picking it routes through the
    // open-case machinery instead of opening a second case - while the denied
    // mug is shown disabled with its reason rather than silently omitted.
    insertRequest(f.db, storedRow(f.customerId, f.orderId, 'REQ-OPEN', 'escalated', [f.lampItemId]));
    insertRequest(f.db, storedRow(f.customerId, f.orderId, 'REQ-DENIED', 'denied', [f.mugItemId]));

    const result = offer();
    expect(result?.items.find((item) => item.itemId === f.lampItemId)).toMatchObject({
      name: LAMP,
      reported: false,
    });
    expect(result?.items.find((item) => item.itemId === f.mugItemId)).toMatchObject({
      name: MUG,
      reported: true,
    });
  });
});

describe('the model may ask, and may be wrong', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture('model@shop.test');
  });

  function offerWith(candidates: readonly string[]) {
    const order = findOrder(f.db, f.customerId, f.orderId, TEST_NOW);
    if (order === null) {
      throw new Error('fixture order missing');
    }
    const identification = identifyOrder(f.db, customerOf(f), f.orderId, 'it is not right', TEST_NOW, []);
    return itemPickerOffer({
      db: f.db,
      customerId: f.customerId,
      order,
      identification,
      gates: runFactGates(contextFor(f), []),
      injectionDetected: false,
      handoffActive: false,
      request: { candidates },
      config: DEFAULT_ITEM_PICKER,
    });
  }

  it('narrows the list to the lines the model nominated', () => {
    const result = offerWith([f.mugItemId]);
    expect(result?.items.map((item) => item.name)).toEqual([MUG]);
    expect(result?.suggested).toEqual([f.mugItemId]);
  });

  it('drops a candidate that is not on this order rather than offering it', () => {
    // The rule `identifyOrder` already applies to ticked ids: an id from another
    // basket narrows nothing, because resolving it elsewhere would put a line in
    // front of the customer that they never bought.
    const result = offerWith(['ITM-NOT-ON-THIS-ORDER']);
    expect(result?.suggested).toEqual([]);
    expect(result?.items.map((item) => item.name).sort()).toEqual([LAMP, MUG].sort());
  });

  it('keeps the valid part of a mixed nomination', () => {
    const result = offerWith([f.mugItemId, 'ITM-NOT-ON-THIS-ORDER']);
    expect(result?.items.map((item) => item.name)).toEqual([MUG]);
    expect(result?.suggested).toEqual([f.mugItemId]);
  });

  it('offers even when the model asked for nothing', () => {
    // "I could not tell them apart" is a legitimate answer, and still an ask.
    const result = offerWith([]);
    expect(result?.items).toHaveLength(2);
    expect(result?.suggested).toEqual([]);
  });
});

describe('a model-selected scope could never reach the money, because there is none', () => {
  it('caps the ceiling to the line the customer ticked, exactly as a hand tick does', () => {
    const f = fixture('ceiling@shop.test');
    const order = findOrder(f.db, f.customerId, f.orderId, TEST_NOW);
    if (order === null) {
      throw new Error('fixture order missing');
    }
    const byHand = identifyOrder(f.db, customerOf(f), f.orderId, 'it is not right', TEST_NOW, [f.mugItemId]);

    // The money assertion from `item-scope.test.ts`, restated for the path the
    // picker feeds: a selection the assistant asked for and the customer made is
    // worth exactly what a selection the customer made first is - and the $129 lamp
    // is outside either.
    expect(disputeCeiling(byHand, order.items)).toBe(2400);
    expect(byHand.items.map((item) => item.name)).toEqual([MUG]);
  });
});

/** A stored request, so the test is about the picker and not about what decides. */
function storedRow(
  customerId: string,
  orderId: string,
  requestId: string,
  decision: Decision,
  claim: readonly string[],
): NewRequestRow {
  const at = TEST_NOW.toISOString();
  return {
    id: requestId,
    createdAt: at,
    customerId,
    customerName: 'Picker Tester',
    orderId,
    message: 'fixture claim',
    messageSha256: '0'.repeat(64),
    messageFingerprint: '0'.repeat(64),
    decision,
    refundAmountCents: 0,
    eligibleAmountCents: 0,
    summary: 'fixture',
    policyRef: 'REFUND_POLICY.md §5.1',
    traceJson: '[]',
    overridesJson: '[]',
    eligibleItemIdsJson: JSON.stringify(claim),
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

describe('end to end, through the pipeline', () => {
  /**
   * The whole feature in one story: a customer describes a problem without naming
   * the item, the assistant offers the picker, nothing is decided, and the answer
   * to it decides the request against the line the customer tapped.
   */
  it('offers the picker instead of deciding, then caps the decision to the tapped line', async () => {
    // The second-turn claim quotes the customer's own words, because an ungrounded
    // fault escalates under R-12 and this test is about the picker, not grounding.
    const h = await shopHarness({
      kind: 'askItems',
      candidates: [],
      then: {
        reason: 'damaged',
        condition: 'damaged',
        items: ['MUG'],
        evidenceQuotes: ['It is about the Harbour Stoneware Mug'],
      },
    });
    try {
      const session = await signIn(h, 'sam@shop.demo');
      const app = h.app;

      // A two-line order, bought through checkout so the ids are real.
      const cart = await app.inject({
        method: 'POST',
        url: '/api/shop/checkout',
        headers: { cookie: session.cookie },
        payload: {
          lines: [
            { productId: 'PRD-LAMP-01', quantity: 1 },
            { productId: 'PRD-MUG-01', quantity: 1 },
          ],
        },
      });
      const order = cart.json<{ order: { id: string; items: readonly { itemId: string; name: string }[] } }>().order;
      const mug = order.items.find((item) => item.name === 'Harbour Stoneware Mug');
      if (mug === undefined) {
        throw new Error('the mug should be on the order just bought');
      }

      // 1. A complaint that names no item: the assistant asks which one, and
      //    nothing is decided - there is no request row to make the offer into.
      const asked = await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: session.cookie },
        payload: {
          customerId: session.customerId,
          orderId: order.id,
          message: 'Something in this delivery went wrong and I want it sorted.',
        },
      });
      // 200, not 201: nothing was created. A question - or an offer - is not a
      // request, and the status is what says so.
      expect(asked.statusCode).toBe(200);
      const offerBody = asked.json<{
        question: string;
        picker: { orderId: string; items: readonly { itemId: string; name: string; reported: boolean }[] } | null;
      }>();
      expect(offerBody.picker).not.toBeNull();
      expect(offerBody.picker?.orderId).toBe(order.id);
      expect(offerBody.picker?.items.map((item) => item.name).sort()).toEqual([
        'Aurora Desk Lamp',
        'Harbour Stoneware Mug',
      ]);
      expect(
        h.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get(),
      ).toMatchObject({ n: 0 });

      // 2. The customer taps the mug. Their tap is the scope, exactly as a tick
      //    sent with a message is - the offer contributed nothing to it. But a tap
      //    states no fault and asks for no money, so the consent gate holds the
      //    payable decision for one confirmation rather than inferring one.
      const confirm = await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: session.cookie },
        payload: {
          customerId: session.customerId,
          orderId: order.id,
          message: `It is about the ${mug.name}`,
          itemIds: [mug.itemId],
        },
      });
      expect(confirm.statusCode).toBe(200);
      const confirmBody = confirm.json<{ question: string }>();
      expect(confirmBody.question).toContain('Before we refund anything:');
      expect(confirmBody.question).toContain('a refund of');
      expect(
        h.db.prepare('SELECT COUNT(*) AS n FROM refund_requests').get(),
      ).toMatchObject({ n: 0 });

      // 2b. "Yes" to the confirmation is consent, recognised by the question's
      //     own marker rather than by restating anything.
      const decided = await app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: session.cookie },
        payload: {
          customerId: session.customerId,
          orderId: order.id,
          message: 'yes',
          itemIds: [mug.itemId],
        },
      });
      expect(decided.statusCode).toBe(201);
      const decision = decided.json<{
        request: { decision: { decision: string; refundAmountCents: number; eligibleAmountCents: number } };
      }>().request.decision;

      // The lamp the customer never claimed is outside this decision, and the
      // record says why: this is the assertion `item-scope.test.ts` makes by hand.
      expect(decision.refundAmountCents).toBe(2400);
      expect(decision.eligibleAmountCents).toBeGreaterThan(2400);
      const codes = decided.json<{ request: { decision: { overrides: readonly { code: string }[] } } }>()
        .request.decision.overrides.map((override) => override.code);
      expect(codes).toContain('amount_limited_to_disputed_items');

      // 3. The thread replays the picker as buttons, not as a sentence.
      const history = await app.inject({
        method: 'GET',
        url: `/api/shop/chat/history?orderId=${order.id}`,
        headers: { cookie: session.cookie },
      });
      const turns = history.json<{ turns: readonly { kind: string; offer?: unknown }[] }>().turns;
      const stored = turns.find((turn) => turn.kind === 'dialogue');
      expect(stored?.offer).not.toBeNull();
    } finally {
      await h.app.close();
      h.db.close();
    }
  });
});
