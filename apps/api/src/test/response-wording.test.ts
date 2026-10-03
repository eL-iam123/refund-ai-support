import { describe, expect, it } from 'vitest';
import { isAttachmentOnly, isFrustrated, acknowledgementFor } from '../response/acknowledge.js';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { processRefundRequest } from '../orchestrator.js';
import { createAttemptRecorder } from '../db/attemptRecorder.js';
import { pendingCentsForOrder } from '../db/refundLedger.js';
import { appHarness, TEST_NOW, decided } from './helpers.js';
import { shopHarness, signIn } from './shop-helpers.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { composeDeterministicResponse } from '../response/compose.js';
import type { OrderRecord } from '../db/records.js';

/**
 * Reply wording for messages the decision already handles correctly.
 *
 * Both cases below escalate for reasons that have nothing to do with tone or
 * attachments, and every test here re-asserts that. The point of the module is to
 * stop the *wording* lying - "a person is reviewing your photo" when there is no
 * photo on the server - and the risk in fixing that is a sympathetic reply that
 * starts moving money. So the amounts are asserted, not just the text.
 */

const APPROVED = 'The lamp arrived broken and I want a refund.';
const LINK_ONLY = 'https://cdn.example.com/IMG_4021.jpg';
const ANGRY = 'Honestly this whole process is a joke. Three weeks ago and still nothing. I want my money now.';

describe('recognising an attachment with no words', () => {
  it('catches a bare image URL', () => {
    expect(isAttachmentOnly(LINK_ONLY)).toBe(true);
  });

  it('catches a bare filename', () => {
    expect(isAttachmentOnly('IMG_4021.jpg')).toBe(true);
  });

  it('catches a link with a brief apology attached', () => {
    expect(isAttachmentOnly('https://example.com/a.png sorry')).toBe(true);
  });

  it('leaves a claim alone even when a link comes with it', () => {
    // The dangerous false positive: a real claim that happens to include a link
    // must keep the ordinary wording, because it did say what was wrong.
    expect(isAttachmentOnly('Here is the photo https://example.com/a.png the mug is in pieces')).toBe(false);
  });

  it('leaves a message alone when it only mentions a picture in words', () => {
    expect(isAttachmentOnly('I sent a photo but it did not go through, the item is broken')).toBe(false);
  });

  it('leaves an ordinary complaint alone', () => {
    expect(isAttachmentOnly(APPROVED)).toBe(false);
  });

  it('leaves a message with no attachment alone', () => {
    expect(isAttachmentOnly('I would like to return this, it is the wrong size')).toBe(false);
  });
});

describe('recognising frustration', () => {
  it('catches repeated chasing and open mockery', () => {
    expect(isFrustrated(ANGRY)).toBe(true);
  });

  it('catches being ignored', () => {
    expect(isFrustrated('Nobody has replied to my emails')).toBe(true);
  });

  it('does not treat an ordinary complaint as frustration', () => {
    expect(isFrustrated(APPROVED)).toBe(false);
    expect(isFrustrated('I would like to return this, it is the wrong size')).toBe(false);
  });

  it('does not treat a polite request as frustration', () => {
    expect(isFrustrated('Could you please look at my order when you have a moment? Thank you.')).toBe(false);
  });
});

describe('the acknowledgement', () => {
  it('says we cannot open attachments, rather than implying we have', () => {
    const text = acknowledgementFor(LINK_ONLY);
    expect(text).toContain('cannot open image attachments');
    // The old wording would have told this customer to wait a business day for a
    // verdict on an image the server never received.
    expect(text).not.toContain('Nothing further is needed');
  });

  it('acknowledges frustration without promising anything', () => {
    const text = acknowledgementFor(ANGRY);
    expect(text).toContain('sorry');
    // Empathy is not an ETA. "A person will reply within one business day" on top
    // of an apology is how an apology reads as a brush-off.
    expect(text).not.toMatch(/business day|within \d/);
  });

  it('is empty for an ordinary complaint', () => {
    expect(acknowledgementFor(APPROVED)).toBe('');
  });
});

describe('the response names the order once, not twice', () => {
  const order = {
    id: 'ORD-1a2b3c',
    customerId: 'CUST-1',
    placedAt: new Date('2026-01-01T00:00:00.000Z'),
    deliveredAt: new Date('2026-01-05T00:00:00.000Z'),
    ageDays: 5,
    status: 'delivered',
    paymentState: 'settled',
    refundedCents: 0,
    totalCents: 2400,
    isSubscription: false,
    trackingStatus: 'delivered',
    signedByCustomer: true,
    conditionAtDelivery: null,
    items: [],
  } as unknown as OrderRecord;

  function composed(outcome: 'exchange' | 'store_credit', forOrder: OrderRecord | null): string {
    return composeDeterministicResponse(
      {
        decision: outcome,
        refundAmountCents: 0,
        eligibleAmountCents: 2400,
        currency: 'USD',
        summary: '',
        policyRef: 'REFUND_POLICY.md §10',
        trace: [],
        overrides: [],
        eligibleItemIds: [],
        blockedItems: [],
        refundId: null,
        refundState: 'none',
      } as unknown as Parameters<typeof composeDeterministicResponse>[0],
      forOrder,
      'My order was late and it is not what I expected.',
    );
  }

  it('reads cleanly for an exchange and for store credit', () => {
    // Both sentences already said "your order"; appending the reference on top of
    // it produced "an exchange for your order for order ORD-1a2b3c", which is the
    // first thing a customer reads when their request is resolved.
    for (const outcome of ['exchange', 'store_credit'] as const) {
      const text = composed(outcome, order);
      expect(text, outcome).toContain('ORD-1a2b3c');
      expect(text, outcome).not.toMatch(/order for order/);
    }
  });

  it('falls back to "your order" when no order was identified', () => {
    // A request raised before an order resolved still has to be answerable.
    expect(composed('exchange', null)).toContain('an exchange for your order');
  });
});

describe('through the real pipeline', () => {
  /**
   * One turn, as the pipeline produced it.
   *
   * A turn can now end in a question - asking before escalating is the point - so the
   * helper reports which it was rather than insisting on a decision, and callers
   * assert what they care about.
   */
  async function run(message: string): Promise<{ decision: string | null; amount: number; reply: string }> {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    const outcome = await processRefundRequest(db, {
      analyzer: FakeAnalyzer({ kind: 'heuristic' }),
      recordAttempt: createAttemptRecorder(db),
      injectionAction: 'deny',
    }, {
      requestId: `REQ-${Math.random().toString(36).slice(2, 8)}`,
      customerId: 'CUST-AOKAFOR',
      orderId: 'ORD-1001',
      message,
      itemIds: [],
      now: TEST_NOW,
    });
    if (outcome.stage === 'asked') {
      return { decision: null, amount: 0, reply: outcome.question };
    }
    return {
      decision: outcome.decision.decision,
      amount: outcome.decision.refundAmountCents,
      reply: outcome.responseText,
    };
  }

  it('tells an attachment-only customer what is actually needed, and pays nothing', async () => {
    // A bare link is unreadable, which is now a question rather than an escalation:
    // one question gets the words, and only an unreadable *second* message pages
    // someone. The acknowledgement comes first, because "what is wrong with it?" on
    // its own would read as though we had not understood the photo at all.
    const result = await run(LINK_ONLY);

    expect(result.reply).toContain('cannot open image attachments');
    expect(result.reply).toMatch(/what has gone wrong/i);
    // No claim was made, so nothing may be paid, whatever the reply says.
    expect(result.amount).toBe(0);
  });

  it('acknowledges an angry customer and still pays nothing without a claim', async () => {
    const result = await run(ANGRY);

    // Anger is not evidence. If this approved, a customer could simply be rude - so
    // the reply acknowledges and then asks for the fact we are actually missing.
    expect(result.reply).toContain('sorry');
    expect(result.amount).toBe(0);
  });

  it('still approves a real damage claim that also carries a photo', async () => {
    // The wording the analyzer actually reads as a damage claim, with evidence
    // bolted on. Attaching a photo must not cost a customer their refund.
    const result = await run(`${APPROVED} Photo: https://example.com/a.png`);

    expect(result.decision).toBe('approved');
    expect(result.amount).toBe(10000);
  });

  it('reads a real claim that arrives after the attachment', async () => {
    const result = await run(`Photo: https://example.com/a.png\n${APPROVED}`);

    // Position of the link is not evidence of anything, either way round.
    expect(result.decision).toBe('approved');
    expect(result.amount).toBe(10000);
  });

  it('does not promise a payment date on an approval', async () => {
    const result = await run(APPROVED);

    expect(result.decision).toBe('approved');
    expect(result.amount).toBe(10000);
    // The money waits on a person, so a date would be a promise the system has
    // not made. What it can honestly say is that the amount is being checked.
    expect(result.reply).not.toMatch(/business days/);
    expect(result.reply).toContain('being checked by a member of our team');
  });
});

describe('a denial that is really about the balance', () => {
  const base = {
    decision: 'denied' as const,
    refundAmountCents: 0,
    eligibleAmountCents: 10000,
    currency: 'USD' as const,
    summary: 'Denied under R-06b: nothing left to refund.',
    policyRef: 'REFUND_POLICY.md §2.5',
    trace: [],
    overrides: [],
    eligibleItemIds: [],
    blockedItems: [],
  };
  const order = { id: 'ORD-1001' } as OrderRecord;

  it('tells a customer their pending refund still stands', () => {
    // The wording this replaces said only "we are not able to refund this order",
    // while a refund for that same order sat pending in the queue. Both true,
    // and together they read as the pending refund being cancelled.
    const text = composeDeterministicResponse(
      { ...base, outstandingAmountCents: 10000, outstandingState: 'pending' },
      order,
      'and here is another one',
    );

    expect(text).toContain('A refund of $100.00 is approved for this order and is waiting to be checked');
  });

  it('says so when the money has already gone back', () => {
    const text = composeDeterministicResponse(
      { ...base, outstandingAmountCents: 10000, outstandingState: 'settled' },
      order,
      'one more',
    );

    // Asserted as a whole sentence: the previous version of this composed
    // "A refund of $100.00 has already been refunded", and a substring
    // assertion on "has already been refunded" passed right through it.
    expect(text).toContain('$100.00 of this order has already been refunded.');
    expect(text).not.toContain('refund of $100.00 has already been refunded');
  });

  it('reads as a sentence when some of the order is settled and some is waiting', () => {
    const text = composeDeterministicResponse(
      { ...base, outstandingAmountCents: 25000, outstandingState: 'mixed' },
      order,
      'and the rest too',
    );

    expect(text).toContain('A refund of $250.00 on this order is already being processed.');
  });

  it('claims nothing about the order when nothing is outstanding', () => {
    const text = composeDeterministicResponse(
      { ...base, outstandingAmountCents: 0, outstandingState: 'none' },
      order,
      'wrong size',
    );

    expect(text).not.toContain('A refund of');
  });
});

describe('through the ledger, end to end', () => {
  it('does not tell a customer with a pending refund that they are getting nothing', async () => {
    const harness = await shopHarness();
    const { db } = harness;
    const shopper = await signIn(harness, 'dana@shop.demo');
    const post = (message: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/chat/messages',
        headers: { cookie: shopper.cookie },
        payload: { customerId: shopper.customerId, orderId: shopper.orderId, message },
      });

    // First claim takes the whole order and reserves it.
    const first = await post(APPROVED);
    expect(first.json<{ request: { decision: { decision: string } } }>().request.decision.decision).toBe('approved');
    expect(pendingCentsForOrder(db, shopper.orderId)).toBe(12900);

    // The next claim finds nothing left, and must not imply the first is void.
    const second = await post('The lamp is also damaged as well');
    const body = second.json<{ request: { decision: { decision: string; refundAmountCents: number }; responseText: string } }>().request;

    expect(body.decision.decision).toBe('denied');
    expect(body.responseText).toContain('A refund of $129.00 is approved for this order');
  });

  it('holds the balance even when the resolver is called outside the chat route', async () => {
    // The reservation used to live in the route, so a caller that resolved a
    // claim without going through HTTP approved the same order twice and left
    // R-06b holding nothing. Now the pairing is one function, and this asserts
    // the ledger agrees with the decision.
    const { db } = await appHarness();
    const { processRefundRequest } = await import('../orchestrator.js');
    const { FakeAnalyzer: fake } = await import('./fakeAnalyzer.js');
    const { createAttemptRecorder: recorder } = await import('../db/attemptRecorder.js');

    const result = decided(await processRefundRequest(db, {
      analyzer: fake({ kind: 'heuristic' }),
      recordAttempt: recorder(db),
      injectionAction: 'deny',
    }, {
      requestId: 'REQ-DIRECT-1',
      customerId: 'CUST-AOKAFOR',
      orderId: 'ORD-1001',
      message: APPROVED,
      itemIds: [],
      now: TEST_NOW,
    }));

    // Deciding does not persist; persisting does. Which is exactly why the
    // reservation is bound to persistence rather than to the decision.
    expect(result.decision.decision).toBe('approved');
    expect(pendingCentsForOrder(db, 'ORD-1001')).toBe(0);
  });
});
