import { describe, expect, it } from 'vitest';
import { nextMissingField, questionForField, alreadyAsked } from '../response/nextQuestion.js';
import type { OrderRecord } from '../db/records.js';

/**
 * Which question comes next, and why.
 *
 * A clarification loop only converges if each turn removes one unknown. These tests
 * are about that: what the thread is still missing, that the question names exactly
 * that, and - the one that matters most - that nothing is asked which the customer has
 * already answered or already been asked.
 */

const LAMP: OrderRecord['items'][number] = {
  id: 'ITM-LAMP', name: 'Aurora Desk Lamp', unitPriceCents: 12_900, quantity: 1,
  finalSale: false, digital: false, downloaded: false, isSubscription: false,
};
const MUG: OrderRecord['items'][number] = {
  id: 'ITM-MUG', name: 'Harbour Stoneware Mug', unitPriceCents: 2_400, quantity: 1,
  finalSale: false, digital: false, downloaded: false, isSubscription: false,
};

const ORDER: OrderRecord = {
  id: 'ORD-1', customerId: 'CUST-1', placedAt: new Date(), deliveredAt: new Date(), ageDays: 4,
  status: 'delivered', paymentState: 'settled', refundedCents: 0, totalCents: 15_300,
  isSubscription: false, trackingStatus: 'delivered', signedByCustomer: true, conditionAtDelivery: null,
  items: [LAMP, MUG],
};

function input(overrides: {
  readonly order?: OrderRecord | null;
  readonly reportedItemIds?: readonly string[];
  /** What `identifyOrder` resolved - a name or a tick the customer has given. */
  readonly resolvedItemIds?: readonly string[];
  readonly customerText?: readonly string[];
  readonly askedText?: readonly string[];
} = {}) {
  return {
    order: overrides.order === undefined ? ORDER : overrides.order,
    reportedItemIds: overrides.reportedItemIds ?? [],
    resolvedItemIds: overrides.resolvedItemIds ?? [],
    customerText: overrides.customerText ?? [],
    askedText: overrides.askedText ?? [],
  };
}

describe('the next question removes exactly one unknown', () => {
  it('asks for the order first, because nothing can be checked without one', () => {
    expect(nextMissingField(input({ order: null }))).toBe('order');
  });

  it('then asks which item, and names the lines and their prices', () => {
    // A claim against a two-line basket is a claim against a line, and the ceiling is
    // built from lines - so this is the question with money behind it.
    const field = nextMissingField(input());
    expect(field).toBe('item');
    const question = questionForField('item', input());
    expect(question).toContain('Aurora Desk Lamp');
    expect(question).toContain('$129.00');
    expect(question).toContain('Harbour Stoneware Mug');
    expect(question).toContain('$24.00');
  });

  it('does not ask which item when the customer has already named or ticked one', () => {
    // The question they just answered, asked again. This is the tone problem the
    // whole feature exists to avoid, and it is why the resolved lines travel with the
    // question rather than being re-derived from the words.
    const named = input({ resolvedItemIds: [LAMP.id], customerText: ['my lamp is damaged'] });
    expect(nextMissingField(named)).not.toBe('item');
    expect(questionForField('reason', named)).toMatch(/what has gone wrong/i);
  });

  it('does not ask which item when only one line is still open', () => {
    // The other line already carries a claim, so there is nothing to choose and a
    // picker with one button on it is a dead end.
    const withOneLeft = input({ reportedItemIds: [LAMP.id] });
    expect(nextMissingField(withOneLeft)).not.toBe('item');
  });

  it('then asks what happened, and offers the policy reasons rather than "tell me more"', () => {
    const oneLine = input({ reportedItemIds: [MUG.id] });
    const field = nextMissingField(oneLine);
    expect(field).toBe('reason');
    const question = questionForField('reason', oneLine);
    // Generic wording is what makes a customer answer with a paragraph and the next
    // turn ask something adjacent to it.
    expect(question).not.toMatch(/tell me a bit more|anything else/i);
    // The customer's words, not the system's: "a fault" is our vocabulary and means
    // nothing to the person reading it.
    expect(question).toContain('broken');
    expect(question).toContain('delivery');
  });

  it('asks about the condition only for a fault, because a delay has no condition', () => {
    // "My order was late" is a complete answer. Asking what condition it arrived in
    // is a question with one obvious answer and a customer who gave it.
    const delayed = input({ reportedItemIds: [MUG.id], customerText: ['My order was late and it never arrived'] });
    expect(nextMissingField(delayed)).toBeNull();
  });

  it('asks nothing once the customer has named the item and the reason', () => {
    const complete = input({
      reportedItemIds: [MUG.id],
      customerText: ['The mug arrived broken and I chipped it'],
    });
    expect(nextMissingField(complete)).toBeNull();
  });
});

describe('nothing is asked that has already been answered or already been asked', () => {
  it('stays quiet when the reason is already in the thread', () => {
    const answered = input({
      reportedItemIds: [MUG.id],
      customerText: ['the mug arrived damaged'],
      askedText: ['What has gone wrong with it?'],
    });
    expect(nextMissingField(answered)).toBeNull();
  });

  it('refuses a question the thread has already asked', () => {
    const one = input({ reportedItemIds: [MUG.id] });
    const question = questionForField('reason', one);
    expect(question).not.toBeNull();
    // The same field asked twice is the single thing that makes a customer stop
    // answering, so the second ask is suppressed and the thread escalates instead.
    expect(questionForField('reason', { ...one, askedText: [question as string] })).toBeNull();
  });

  it('recognises a reworded repeat as the same question', () => {
    // A model asking "what condition was the mug in?" and the deterministic question
    // being "in what condition did the mug arrive?" is one question asked twice, and
    // the customer experiences it as being ignored.
    // The two that must not merge: the reason field and the condition field are the
    // two layers of the onion, and collapsing them is how a loop stops peeling.
    const condition = questionForField('condition', input({
      reportedItemIds: [MUG.id],
      customerText: ['the mug is damaged'],
    }));
    expect(alreadyAsked(condition, ['what condition was the mug in'])).toBe(true);
    expect(alreadyAsked(condition, ['what has gone wrong with it'])).toBe(false);
    expect(alreadyAsked(null, ['anything'])).toBe(false);
  });
});

describe("the questions are read by a customer, not by the system", () => {
  it('never names a rule, a policy or an internal field', () => {
    // These sentences are read verbatim by a customer. A field name in one of them is
    // a bug that ships.
    for (const text of [
      questionForField('order', input({ order: null })),
      questionForField('item', input()),
      questionForField('reason', input({ reportedItemIds: [MUG.id] })),
      questionForField('condition', input({ reportedItemIds: [MUG.id], customerText: ['the mug is damaged'] })),
    ]) {
      expect(text, String(text)).not.toMatch(/policy|rule|R-0|REFUND_POLICY|grounding|confidence|evidence/i);
    }
  });
});

describe('an opening question greets first', () => {
  it('greets on hello instead of opening with an interrogation', () => {
    // The reported transcript: "hello" answered with "Is this about the lamp
    // or the kettle?" - the right question with no hello in it, which reads
    // as a multiple-choice quiz in reply to a greeting.
    const question = questionForField('item', input({ customerText: ['hello'], askedText: [] }));
    expect(question).toMatch(/^Hello!/);
    expect(question).toContain('or a different one?');
  });

  it('does not greet mid-thread', () => {
    const question = questionForField(
      'item',
      input({ customerText: ['hello', 'I need help with my order'], askedText: ['What has gone wrong with it?'] }),
    );
    expect(question).not.toMatch(/hello/i);
    expect(question).toMatch(/^Is this about/);
  });

  it('greets a reason opener on a single-line order too', () => {
    const question = questionForField(
      'reason',
      input({ order: { ...ORDER, items: [MUG] }, customerText: ['hello'], askedText: [] }),
    );
    expect(question).toMatch(/^Hello!/);
    expect(question).toMatch(/what has gone wrong/i);
  });

  it('compares questions without their openers', () => {
    // The greeting is shared, so the dedup must compare without it: the same
    // question greeted and ungreeted is asked twice, while an item question
    // and a reason question stay two different questions even greeted.
    const mugOnly = questionForField(
      'item',
      input({ reportedItemIds: [LAMP.id], customerText: ['hello'], askedText: [] }),
    ) as string;
    expect(mugOnly).toMatch(/^Hello!/);
    expect(alreadyAsked(mugOnly, [mugOnly])).toBe(true);
    expect(
      alreadyAsked(mugOnly, [mugOnly.replace(/^Hello! Thanks for getting in touch\. /, '')]),
    ).toBe(true);
    const reason = questionForField(
      'reason',
      input({ reportedItemIds: [MUG.id], customerText: ['hello'], askedText: [] }),
    ) as string;
    expect(alreadyAsked(mugOnly, [reason])).toBe(false);
  });
});
