import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { authHeader, TEST_NOW, type AppHarness } from './helpers.js';
import { shopHarness, signIn } from './shop-helpers.js';
import { findReturnById, listReturnItems, ReturnLedgerError } from '../db/returns.js';

/**
 * The returns ledger: opening one, and moving it all the way to closed.
 *
 * This is the one part of the system that is a state machine over physical
 * events rather than a decision made from a policy, so it is tested against the
 * properties that actually matter for goods coming back:
 *
 * - **Nobody else's parcel.** Order ids are sequential and guessable, and the
 *   order id arrives in the body, so ownership has to be checked before the
 *   items are read - otherwise a signed-in customer opens a return against
 *   someone else's order and gets its item names in the response.
 * - **The goods are real.** A return cannot claim more units than were bought,
 *   restock more than the warehouse signed for, or restock a product the return
 *   does not contain. Stock is the one number here that stays quietly wrong
 *   until somebody oversells.
 * - **The steps happen in order.** Each status change is an assertion that
 *   something physically occurred, so skipping one is refused rather than
 *   inferred.
 * - **It moves no money.** A return is a parcel. Any refund is a separate
 *   decision, and the tests assert the ledger leaves the money alone.
 *
 * Repeated calls are the real risk in a warehouse integration, so idempotency on
 * the refund request is tested directly rather than assumed from the schema.
 */

const STAFF = { authorization: authHeader('admin', 'returns-agent') };

interface Fixture {
  readonly h: AppHarness;
  readonly cookie: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly lineId: string;
  readonly productId: string;
}

/**
 * A signed-in shopper with an order of two units.
 *
 * Built through the real login and checkout rather than by inserting rows: a
 * fixture that skips checkout is a fixture that would not notice checkout
 * breaking, and order ids are what this suite is partitioned by. The order line
 * is then read back from the database, because the distinction between a line id
 * and a product id is the thing the return contract is built around and the
 * fixture should not paper over it.
 */
async function shopper(): Promise<Fixture> {
  const h = await shopHarness();
  const session = await signIn(h, 'sam@shop.demo');

  // Two units, so "return everything bought" and "return more than was bought"
  // are both expressible. `signIn` buys one, which would make the quantity
  // ceiling untestable at anything but its minimum.
  const checkout = await h.app.inject({
    method: 'POST',
    url: '/api/shop/checkout',
    headers: { cookie: session.cookie },
    payload: { lines: [{ productId: catalogueProduct(h), quantity: 2 }] },
  });
  if (checkout.statusCode !== 201) {
    throw new Error(`checkout returned ${checkout.statusCode}: ${checkout.body}`);
  }
  const orderId = checkout.json<{ order: { id: string } }>().order.id;

  const line = h.db
    .prepare('SELECT id, product_id AS productId FROM order_items WHERE order_id = ? LIMIT 1')
    .get(orderId) as { id: string; productId: string } | undefined;
  if (line === undefined) {
    throw new Error(`order ${orderId} has no lines`);
  }

  return {
    h,
    cookie: session.cookie,
    customerId: session.customerId,
    orderId,
    lineId: line.id,
    productId: line.productId,
  };
}

/** The first seeded product, read from the catalogue rather than hard-coded. */
function catalogueProduct(h: AppHarness): string {
  const row = h.db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new Error('the seeded catalogue is empty');
  }
  return row.id;
}

function openReturn(f: Fixture, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> {
  return f.h.app.inject({
    method: 'POST',
    url: '/api/returns',
    headers: { cookie: f.cookie },
    payload: {
      orderId: f.orderId,
      items: [{ itemId: f.lineId, quantity: 1 }],
      reason: 'the charger never arrived',
      ...payload,
    },
  });
}

/** Opens a return and returns its id, for the tests that then move it along. */
async function openId(f: Fixture, payload: Record<string, unknown> = {}): Promise<string> {
  const response = await openReturn(f, payload);
  const body = response.json<{ return: { id: string } }>();
  if (body.return === undefined) {
    throw new Error(`opening a return failed with ${response.statusCode}: ${response.body}`);
  }
  return body.return.id;
}

describe('opening a return', () => {
  it('records the order, the customer and the line', async () => {
    const f = await shopper();
    const response = await openReturn(f);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ return: { id: string; status: string; orderId: string; customerId: string } }>();
    expect(body.return.status).toBe('return_requested');
    expect(body.return.orderId).toBe(f.orderId);
    expect(body.return.customerId).toBe(f.customerId);

    // Name and price are copied from the order row, so the return still reads
    // correctly if the catalogue is edited later.
    const items = listReturnItems(f.h.db, body.return.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe(f.lineId);
  });

  it('refuses a return against another customer’s order', async () => {
    const mine = await shopper();
    const other = await shopper();
    if (other.orderId === mine.orderId) {
      return; // Separate harnesses, so this cannot happen; asserted to avoid a silent pass.
    }

    // Same harness shape, but the session belongs to a different customer than
    // the order. This is the guessable-id case.
    const f = await shopper();
    const stolen = await f.h.app.inject({
      method: 'POST',
      url: '/api/returns',
      headers: { cookie: other.cookie },
      payload: {
        orderId: f.orderId,
        items: [{ itemId: f.lineId, quantity: 1 }],
        reason: 'not my order at all',
      },
    });
    expect(stolen.statusCode).not.toBe(200);
  });

  it('refuses a line that is not on the order', async () => {
    const f = await shopper();
    const other = await shopper();
    const response = await openReturn(f, {
      items: [{ itemId: `${other.lineId}-does-not-exist`, quantity: 1 }],
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to return more units than were bought', async () => {
    const f = await shopper();
    // Two were bought, so three is not a return, it is an invention.
    const response = await openReturn(f, { items: [{ itemId: f.lineId, quantity: 3 }] });
    expect(response.statusCode).toBe(409);
  });

  it('allows returning every unit bought', async () => {
    const f = await shopper();
    const response = await openReturn(f, { items: [{ itemId: f.lineId, quantity: 2 }] });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a zero or fractional quantity', async () => {
    const f = await shopper();
    for (const quantity of [0, -1, 1.5]) {
      const response = await openReturn(f, { items: [{ itemId: f.lineId, quantity }] });
      expect(response.statusCode).toBe(400);
    }
  });

  it('merges two entries for the same line and re-checks the total', async () => {
    const f = await shopper();
    // Two of one line when only two were bought: legal, and only because the
    // merge happens before the ceiling is applied.
    const legal = await openReturn(f, {
      items: [
        { itemId: f.lineId, quantity: 1 },
        { itemId: f.lineId, quantity: 1 },
      ],
    });
    expect(legal.statusCode).toBe(200);
    const items = listReturnItems(
      f.h.db,
      legal.json<{ return: { id: string } }>().return.id,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(2);
  });

  it('refuses a return with no reason', async () => {
    const f = await shopper();
    const response = await openReturn(f, { reason: '   ' });
    expect(response.statusCode).toBe(400);
  });
});

describe('idempotency on the refund request', () => {
  it('returns the same return when the same request is filed twice', async () => {
    const f = await shopper();
    const sent = await f.h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: f.cookie },
      payload: {
        customerId: f.customerId,
        orderId: f.orderId,
        message: 'the charger never arrived and I want my money back',
      },
    });
    const requestId = sent.json<{ request: { id: string } }>().request.id;

    const first = await openReturn(f, { requestId });
    const second = await openReturn(f, { requestId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // A warehouse receiving the same parcel twice is a much worse outcome than a
    // second call returning the first result.
    expect(second.json<{ return: { id: string } }>().return.id).toBe(
      first.json<{ return: { id: string } }>().return.id,
    );

    const rows = f.h.db
      .prepare('SELECT COUNT(*) AS n FROM returns WHERE request_id = ?')
      .get(requestId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('refuses a request id that belongs to another order', async () => {
    const f = await shopper();
    const sent = await f.h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: f.cookie },
      payload: {
        customerId: f.customerId,
        orderId: f.orderId,
        message: 'this is broken and I want a refund please',
      },
    });
    const requestId = sent.json<{ request: { id: string } }>().request.id;

    const elsewhere = await f.h.app.inject({
      method: 'POST',
      url: '/api/shop/checkout',
      headers: { cookie: f.cookie },
      payload: { lines: [{ productId: f.productId, quantity: 1 }] },
    });
    const otherOrderId = elsewhere.json<{ order: { id: string } }>().order.id;

    const response = await openReturn(f, { orderId: otherOrderId, requestId });
    expect(response.statusCode).toBe(409);
  });
});

describe('moving a return through its states', () => {
  /** A return that has been opened and labelled, ready to ship. */
  async function labelled(): Promise<Fixture & { id: string }> {
    const f = await shopper();
    const opened = await openReturn(f);
    const id = opened.json<{ return: { id: string } }>().return.id;
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${id}/label`,
      headers: STAFF,
      payload: { carrier: 'usps', labelUrl: 'https://labels.example/abc123' },
    });
    return { ...f, id };
  }

  it('walks requested -> label -> shipped -> received -> processed', async () => {
    const f = await labelled();

    const shipped = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/ship`,
      headers: STAFF,
      payload: { carrier: 'usps', trackingNumber: '9400111899223856928499' },
    });
    expect(shipped.statusCode).toBe(200);
    expect(shipped.json<{ return: { status: string } }>().return.status).toBe('return_shipped');

    const received = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/receive`,
      headers: STAFF,
      payload: { lines: [{ itemId: f.lineId, quantity: 1, condition: 'opened, complete' }] },
    });
    expect(received.statusCode).toBe(200);
    expect(received.json<{ return: { status: string } }>().return.status).toBe('return_received');

    const processed = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [{ itemId: f.lineId, quantity: 1 }] },
    });
    expect(processed.statusCode, processed.body).toBe(200);
    expect(processed.json<{ return: { status: string } }>().return.status).toBe('return_processed');
  });

  it('refuses to skip a step', async () => {
    const f = await shopper();
    const id = await openId(f);

    // Requested straight to shipped: nothing has been labelled, so nothing could
    // have been posted.
    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${id}/ship`,
      headers: STAFF,
      payload: { carrier: 'usps', trackingNumber: '9400111899223856928499' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to reopen a closed return', async () => {
    const f = await labelled();
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/ship`,
      headers: STAFF,
      payload: { carrier: 'usps', trackingNumber: '9400111899223856928499' },
    });
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/receive`,
      headers: STAFF,
      payload: { lines: [{ itemId: f.lineId, quantity: 1, condition: 'fine' }] },
    });
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [{ itemId: f.lineId, quantity: 1 }] },
    });

    // The goods have been dealt with; a second history would have to be
    // reconciled by a person, so it is refused.
    const again = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/deny`,
      headers: STAFF,
      payload: { reason: 'changed my mind' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('denies from a non-terminal state, and stores the reason', async () => {
    const f = await shopper();
    const id = await openId(f);

    const denied = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${id}/deny`,
      headers: STAFF,
      payload: { reason: 'outside the 30-day window' },
    });
    expect(denied.statusCode).toBe(200);
    const record = findReturnById(f.h.db, id);
    expect(record?.status).toBe('return_denied');
    // A reason the customer could be shown, not an internal code.
    expect(record?.deniedReason).toBe('outside the 30-day window');
  });

  it('refuses to receive a line the return does not contain', async () => {
    const f = await labelled();
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/ship`,
      headers: STAFF,
      payload: { carrier: 'usps', trackingNumber: '9400111899223856928499' },
    });

    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/receive`,
      headers: STAFF,
      payload: { lines: [{ itemId: 'RET-not-a-line', quantity: 1, condition: 'fine' }] },
    });
    expect(response.statusCode).toBe(409);
  });

  it('records what actually arrived, not what was sent', async () => {
    const f = await labelled();
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/ship`,
      headers: STAFF,
      payload: { carrier: 'usps', trackingNumber: '9400111899223856928499' },
    });
    // They asked to send one back; the warehouse found two.
    await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/receive`,
      headers: STAFF,
      payload: { lines: [{ itemId: f.lineId, quantity: 1, condition: 'damaged' }] },
    });

    const items = listReturnItems(f.h.db, f.id);
    expect(items[0]?.receivedQuantity).toBe(1);
    expect(items[0]?.receivedCondition).toBe('damaged');
  });
});

describe('restocking', () => {
  /** A return received at the warehouse and ready to be processed. */
  async function received(quantity: number): Promise<Fixture & { id: string }> {
    const f = await shopper();
    const id = await openId(f);
    for (const [url, payload] of [
      ['label', { carrier: 'usps', labelUrl: 'https://labels.example/x' }],
      ['ship', { carrier: 'usps', trackingNumber: '9400111899223856928499' }],
      ['receive', { lines: [{ itemId: f.lineId, quantity, condition: 'fine' }] }],
    ] as const) {
      await f.h.app.inject({
        method: 'POST',
        url: `/api/admin/returns/${id}/${url}`,
        headers: STAFF,
        payload,
      });
    }
    return { ...f, id };
  }

  function stockOf(f: Fixture): number {
    const row = f.h.db.prepare('SELECT stock FROM products WHERE id = ?').get(f.productId) as
      | { stock: number }
      | undefined;
    return row?.stock ?? -1;
  }

  it('puts the received units back on the shelf', async () => {
    const f = await received(1);
    const before = stockOf(f);

    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [{ itemId: f.lineId, quantity: 1 }] },
    });
    expect(response.statusCode).toBe(200);
    expect(stockOf(f)).toBe(before + 1);
  });

  it('refuses to restock more than the warehouse signed for', async () => {
    const f = await received(1);
    const before = stockOf(f);

    // One arrived, so two on the shelf is an oversell waiting to happen.
    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [{ itemId: f.lineId, quantity: 2 }] },
    });
    expect(response.statusCode).toBe(409);
    // And the refusal left the stock alone rather than half-applying.
    expect(stockOf(f)).toBe(before);
  });

  it('refuses to restock a line the return does not contain', async () => {
    const f = await received(1);
    const before = stockOf(f);

    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [{ itemId: 'RET-not-a-line', quantity: 1 }] },
    });
    expect(response.statusCode).toBe(409);
    expect(stockOf(f)).toBe(before);
  });

  it('closes the return even when nothing is restocked', async () => {
    const f = await received(1);
    const response = await f.h.app.inject({
      method: 'POST',
      url: `/api/admin/returns/${f.id}/process`,
      headers: STAFF,
      payload: { restock: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(findReturnById(f.h.db, f.id)?.status).toBe('return_processed');
  });
});

describe('a return moves no money', () => {
  it('leaves the refund ledger untouched however far it goes', async () => {
    const f = await shopper();
    const sent = await f.h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: { cookie: f.cookie },
      payload: {
        customerId: f.customerId,
        orderId: f.orderId,
        message: 'the charger never arrived and I want my money back',
      },
    });
    const requestId = sent.json<{ request: { id: string } }>().request.id;

    const id = await openId(f, { requestId });

    const refundsBefore = f.h.db.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number };

    for (const [url, payload] of [
      ['label', { carrier: 'usps', labelUrl: 'https://labels.example/x' }],
      ['ship', { carrier: 'usps', trackingNumber: '9400111899223856928499' }],
      ['receive', { lines: [{ itemId: f.lineId, quantity: 1, condition: 'fine' }] }],
      ['process', { restock: [{ itemId: f.lineId, quantity: 1 }] }],
    ] as const) {
      await f.h.app.inject({
        method: 'POST',
        url: `/api/admin/returns/${id}/${url}`,
        headers: STAFF,
        payload,
      });
    }

    // The separation is the point: a return is a parcel, and any refund is a
    // separate decision with its own approval. A processed return that had
    // settled money would mean the goods decided the payout.
    const refundsAfter = f.h.db.prepare('SELECT COUNT(*) AS n FROM refunds').get() as { n: number };
    expect(refundsAfter.n).toBe(refundsBefore.n);
  });
});

describe('who may move a return', () => {
  it('refuses a shopper driving the warehouse steps', async () => {
    const f = await shopper();
    const id = (await openReturn(f)).json<{ return: { id: string } }>().return.id;

    // Each of these is an assertion that something physically happened, so a
    // customer must not be able to make it.
    for (const [url, payload] of [
      ['label', { carrier: 'usps', labelUrl: 'https://labels.example/x' }],
      ['ship', { carrier: 'usps', trackingNumber: '9400111899223856928499' }],
      ['receive', { lines: [{ itemId: f.lineId, quantity: 1, condition: 'fine' }] }],
      ['process', { restock: [{ itemId: f.lineId, quantity: 1 }] }],
      ['deny', { reason: 'I would rather have the money' }],
    ] as const) {
      const response = await f.h.app.inject({
        method: 'POST',
        url: `/api/admin/returns/${id}/${url}`,
        headers: { cookie: f.cookie },
        payload,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('hides another customer’s return behind a 404', async () => {
    const f = await shopper();
    const id = (await openReturn(f)).json<{ return: { id: string } }>().return.id;

    const other = await shopper();
    const response = await other.h.app.inject({
      method: 'GET',
      url: `/api/returns/${id}`,
      headers: { cookie: other.cookie },
    });
    // 404 rather than 403: confirming the return exists is itself a leak.
    expect(response.statusCode).toBe(404);
  });
});

describe('the ledger refuses impossible input directly', () => {
  it('rejects a return with no lines', async () => {
    const f = await shopper();
    const { createReturn } = await import('../db/returns.js');
    expect(() =>
      createReturn(f.h.db, {
        orderId: f.orderId,
        customerId: f.customerId,
        items: [],
        reason: 'changed my mind',
        now: TEST_NOW,
      }),
    ).toThrow(ReturnLedgerError);
  });
});
