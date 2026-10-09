import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, type Db } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { findOrder, listOrdersForCustomer } from '../db/orderRepository.js';
import { findCustomer } from '../db/sql.js';
import { disputeCeiling, identifyOrder } from '../retrieval/identifyOrder.js';
import { matchOrders, scopeItems } from '../retrieval/keywords.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { TEST_NOW } from './helpers.js';

/**
 * Mentioning a product is not the same as claiming it.
 *
 * "Only the mug arrived broken, the lamp is perfect" names both items, and a
 * matcher that counts mentions refunds the lamp the customer just said was fine.
 * That is money handed back without a claim, so the behaviour is pinned here
 * rather than left to the heuristic to stay accidentally correct.
 *
 * The fixtures are real orders built through the storefront's own checkout, so
 * these tests exercise the same rows the decision engine would read rather than
 * a hand-written record that could drift from the real shape.
 */

const LAMP = 'Aurora Desk Lamp';
const MUG = 'Harbour Stoneware Mug';

describe('item scope excludes products named only to be ruled out', () => {
  let db: Db;
  let customerId: string;
  let orderId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);

    const user = createUser(
      db,
      { email: 'scope@shop.test', password: 'a-good-password', name: 'Scope Tester' },
      TEST_NOW,
    );
    customerId = user.customerId;
    const order = checkout(
      db,
      customerId,
      [
        { productId: 'PRD-LAMP-01', quantity: 1 },
        { productId: 'PRD-MUG-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    orderId = order.id;
  });

  /** The product names a message would put in dispute on the order above. */
  function scopeOf(message: string): readonly string[] {
    const order = findOrder(db, customerId, orderId, TEST_NOW);
    if (order === null) {
      throw new Error('fixture order missing');
    }
    return scopeItems(matchOrders([order], message), message).map((item) => item.name);
  }

  function identify(message: string): ReturnType<typeof identifyOrder> {
    const customer = findCustomer(db, customerId, TEST_NOW);
    if (customer === null) {
      throw new Error('fixture customer missing');
    }
    return identifyOrder(db, customer, orderId, message, TEST_NOW);
  }

  it('keeps the item that is complained about', () => {
    expect(scopeOf('the mug arrived broken')).toEqual([MUG]);
  });

  it('drops an item the same sentence calls perfect', () => {
    expect(scopeOf('only the mug arrived broken, the lamp is perfect')).toEqual([MUG]);
  });

  it('handles "but" as the clause boundary too', () => {
    expect(scopeOf('the mug arrived broken but the lamp is fine')).toEqual([MUG]);
  });

  it('keeps both when neither is ruled out', () => {
    const scoped = [...scopeOf('the mug arrived broken and the lamp shade is cracked')].sort();
    const both = [LAMP, MUG].sort();

    expect(scoped).toEqual(both);
  });

  it('keeps the item when one clause faults it and another excuses it', () => {
    // A product that is both complained about and pardoned is contradictory, not
    // exculpated, so the claim stands and the resolver can escalate on it.
    expect(scopeOf('the mug arrived broken, though the mug is otherwise fine')).toEqual([MUG]);
  });

  it('treats a whole order described as fine as no claim at all', () => {
    expect(scopeOf('everything arrived in good condition, no issues at all')).toEqual([]);
  });

  it('does not rule an item out on an unrelated clause', () => {
    expect(scopeOf('the lamp is fine overall but the mug is cracked and ruined')).toEqual([MUG]);
  });

  it('never rules out an item the message says nothing kind about', () => {
    expect(scopeOf('the lamp arrived cracked')).toEqual([LAMP]);
  });

  it('caps the refund ceiling at the disputed item, not the whole basket', () => {
    // The money assertion, stated in product names so the intent survives: the
    // lamp must not be inside the dispute that only mentions the mug.
    const found = identify('only the mug arrived broken, the lamp is perfect');

    expect(found.order?.id).toBe(orderId);
    expect(found.items.map((item) => item.name)).toEqual([MUG]);
  });

  it('leaves the whole order in scope when the message names nothing', () => {
    // The opposite failure: over-narrowing would hide a legitimate claim, so an
    // unnameable dispute stays whole rather than becoming an empty ceiling.
    const found = identify('something in this delivery went wrong');

    expect(found.items).toEqual([]);
  });

  it('resolves the only order on file when no id is supplied', () => {
    const customer = findCustomer(db, customerId, TEST_NOW);
    if (customer === null) {
      throw new Error('fixture customer missing');
    }
    const found = identifyOrder(db, customer, null, 'the mug arrived broken', TEST_NOW);

    // One order and one clear product mention: unambiguous, so no person needed.
    expect(found.order?.id).toBe(orderId);
    expect(found.basis).toBe('only_order');
  });

  it('leaves order ranking independent of the negation heuristic', () => {
    const orders = listOrdersForCustomer(db, customerId, TEST_NOW);
    const result = matchOrders(orders, 'the mug arrived broken, the lamp is perfect');

    // Only the item ceiling consults negation. Order choice must still see the
    // mug, or a message praising one item would stop identifying the order.
    expect(result.matches[0]?.order.id).toBe(orderId);
  });
});

/**
 * The storefront's item picker.
 *
 * A tick names a line by id, which is the one claim about an item that cannot be
 * misread. These hold the two properties that make it safe to trust: a tick
 * overrides what the message appears to say, and an id the order does not contain
 * narrows nothing rather than being resolved somewhere else.
 */
describe('a ticked item is the claim, whatever the message says', () => {
  let db: Db;
  let customerId: string;
  let orderId: string;
  let lampItemId: string;
  let mugItemId: string;

  beforeEach(() => {
    db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);

    const user = createUser(
      db,
      { email: 'ticks@shop.test', password: 'a-good-password', name: 'Tick Tester' },
      TEST_NOW,
    );
    customerId = user.customerId;
    const order = checkout(
      db,
      customerId,
      [
        { productId: 'PRD-LAMP-01', quantity: 1 },
        { productId: 'PRD-MUG-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    orderId = order.id;
    const lines = order.items;
    lampItemId = lines.find((item) => item.name === LAMP)?.itemId ?? '';
    mugItemId = lines.find((item) => item.name === MUG)?.itemId ?? '';
  });

  function identify(message: string, itemIds: readonly string[]): ReturnType<typeof identifyOrder> {
    const customer = findCustomer(db, customerId, TEST_NOW);
    if (customer === null) {
      throw new Error('fixture customer missing');
    }
    return identifyOrder(db, customer, orderId, message, TEST_NOW, itemIds);
  }

  it('scopes the claim to the ticked line when the message names nothing', () => {
    const found = identify('something in this delivery went wrong', [mugItemId]);

    expect(found.items.map((item) => item.name)).toEqual([MUG]);
  });

  it('wins over the keyword matcher when the message names another item', () => {
    const found = identify('the lamp arrived cracked', [mugItemId]);

    expect(found.items.map((item) => item.name)).toEqual([MUG]);
  });

  it('takes every ticked line, not just the first', () => {
    const found = identify('both of these are wrong', [lampItemId, mugItemId]);

    expect([...found.items.map((item) => item.name)].sort()).toEqual([LAMP, MUG].sort());
  });

  it('ignores an id that is not on the order rather than resolving it elsewhere', () => {
    const found = identify('something in this delivery went wrong', ['ITM-NOT-ON-THIS-ORDER']);

    // No ticked line on this order, so the ordinary matcher decides - and a
    // message that names nothing stays a whole-order claim rather than becoming
    // an empty one.
    expect(found.order?.id).toBe(orderId);
    expect(found.items).toEqual([]);
  });

  it('leaves the order standing even when the message describes another one', () => {
    // A second basket holding the product the message names. Without a tick this
    // message is a conflict that escalates; with one, the customer has already
    // said which basket they mean.
    checkout(db, customerId, [{ productId: 'PRD-KETTLE-01', quantity: 1 }], TEST_NOW);
    const found = identify('the kettle is broken', [mugItemId]);

    expect(found.order?.id).toBe(orderId);
    expect(found.items.map((item) => item.name)).toEqual([MUG]);
  });

  it('identifies the order from the selection when no order was named', () => {
    const customer = findCustomer(db, customerId, TEST_NOW);
    if (customer === null) {
      throw new Error('fixture customer missing');
    }
    const found = identifyOrder(db, customer, null, 'please refund', TEST_NOW, [mugItemId]);

    expect(found.order?.id).toBe(orderId);
    expect(found.items.map((item) => item.name)).toEqual([MUG]);
  });

  it('carries the selection into the ceiling the resolver uses', () => {
    const found = identify('something went wrong', [mugItemId]);

    // The money assertion: the ceiling is the ticked line, so the lamp the
    // customer never claimed cannot be inside an approval.
    expect(disputeCeiling(found, found.order?.items ?? [])).toBe(
      found.order?.items.find((item) => item.name === MUG)?.unitPriceCents,
    );
  });

  it('gives a zero ceiling, not the whole basket, when every named item is blocked', () => {
    // A basket with one final-sale line and one eligible line. Claiming only the
    // final-sale coat must cap the refund at zero - never amount to "named nothing,
    // whole order" and open the eligible lamp the customer did not mention.
    const coatOrder = checkout(
      db,
      customerId,
      [
        { productId: 'PRD-JACKET-01', quantity: 1 },
        { productId: 'PRD-LAMP-01', quantity: 1 },
      ],
      TEST_NOW,
    );
    const order = findOrder(db, customerId, coatOrder.id, TEST_NOW);
    if (order === null) {
      throw new Error('coat fixture order missing');
    }
    const coatItem = order.items.find((item) => item.finalSale);
    const lampItem = order.items.find((item) => !item.finalSale);
    expect(coatItem).toBeDefined();
    expect(lampItem).toBeDefined();

    const customer = findCustomer(db, customerId, TEST_NOW);
    if (customer === null) {
      throw new Error('fixture customer missing');
    }
    const found = identifyOrder(db, customer, order.id, 'the final-sale coat is broken', TEST_NOW);

    // The message names the coat, so the identification is scoped, and the coat
    // is the only disputed line. Against the eligible set (the lamp), a ceiling
    // of null would mean the full eligible amount; the guard must make it 0.
    expect(found.items.map((item) => item.name)).toEqual(['Meridian Wool Coat (final sale)']);
    const eligibleItems = order.items.filter((item) => !item.finalSale);
    expect(disputeCeiling(found, eligibleItems)).toBe(0);
  });
});
