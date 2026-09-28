import type { Db } from '../db/connection.js';
import { createUser } from './auth.js';
import { checkout, insertProduct, type Product } from './catalogue.js';

/**
 * Storefront seed data.
 *
 * The catalogue is not random filler. Each item is chosen because a refund rule
 * treats it differently, and `tests_policy` names that rule on the product card
 * so a tester can aim at a behaviour instead of guessing. A shop of four
 * identical lamps would make the assistant look like it works while proving
 * nothing.
 *
 * Demo accounts exist so the storefront can be tried without typing a password,
 * and they are passwordless *only* for accounts flagged `is_demo`. That flag is
 * what keeps the one-click shortcut from becoming a backdoor into every real
 * account in the database.
 */

const CATALOGUE: readonly Product[] = [
  {
    id: 'PRD-LAMP-01',
    name: 'Aurora Desk Lamp',
    blurb: 'Brass, dimmable, the one everyone buys first',
    description:
      'A solid brass desk lamp with a weighted base and a stepless dimmer. Comes with a two-year warranty. If it arrives cracked or stops working, the faulty-goods path approves a refund on the affected item.',
    priceCents: 12900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 40,
    testsPolicy: 'R-04 faulty goods',
    imageHue: 44,
  },
  {
    id: 'PRD-JACKET-01',
    name: 'Meridian Wool Coat (final sale)',
    blurb: 'Marked final sale, so a change of heart is not covered',
    description:
      'A wool-blend overcoat, reduced from its original price and marked final sale. Final-sale items are not returnable on preference, so asking for a refund without a fault will be declined. Buying it is a good way to see a denial for the right reason.',
    priceCents: 24800,
    finalSale: true,
    digital: false,
    isSubscription: false,
    stock: 12,
    testsPolicy: 'R-02 final sale is not refundable',
    imageHue: 210,
  },
  {
    id: 'PRD-COFFEE-01',
    name: 'Coffee Subscription (monthly)',
    blurb: 'A recurring order, which changes which rules apply',
    description:
      'Three bags of single-origin coffee a month, cancellable any time. Subscriptions are treated differently from one-off purchases: the delivery window and cancellation rules are not the same, so this item is here to show the difference rather than to be refunded easily.',
    priceCents: 4200,
    finalSale: false,
    digital: false,
    isSubscription: true,
    stock: 999,
    testsPolicy: 'R-08 subscriptions and repeat claims',
    imageHue: 28,
  },
  {
    id: 'PRD-GUIDE-01',
    name: 'KettleMaster Repair Guide (digital)',
    blurb: 'An instant download with no physical item to return',
    description:
      'A downloadable repair manual. There is nothing to ship and nothing to return, so a refund is a cancellation of a download rather than a return of goods. Buy it to see how the policy handles an item that will never arrive.',
    priceCents: 1900,
    finalSale: false,
    digital: true,
    isSubscription: false,
    stock: 999,
    testsPolicy: 'R-07 digital goods are not returnable',
    imageHue: 280,
  },
  {
    id: 'PRD-MUG-01',
    name: 'Harbour Stoneware Mug',
    blurb: 'The everyday item, for testing a simple damaged-item refund',
    description:
      'A heavy stoneware mug, dishwasher and microwave safe. A plain, cheap, physical item with a straightforward fault claim: the simplest possible case for the assistant to get right, and the best baseline before trying anything harder.',
    priceCents: 2400,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 150,
    testsPolicy: 'R-04 faulty goods',
    imageHue: 160,
  },
  {
    id: 'PRD-HEADPHONES-01',
    name: 'Quietline Wireless Headphones',
    blurb: 'Sealed box, so an opened-box claim gets denied',
    description:
      'Over-ear wireless headphones in a sealed retail box. Refunds on opened electronics are declined, so buying this and claiming a fault without the packaging is a quick way to see a policy denial that is doing its job.',
    priceCents: 18900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 30,
    testsPolicy: 'R-06 sealed packaging must be intact',
    imageHue: 320,
  },
];

/**
 * The demo accounts.
 *
 * Passwords are fixed and published on purpose: these are throwaway accounts on
 * a demo storefront, and a memorable password is a feature when the goal is for
 * someone to try the flow in ten seconds. They are flagged `is_demo`, which is
 * the only reason `POST /api/shop/demo-login` will issue a session for them.
 */
const DEMO_ACCOUNTS: readonly { email: string; name: string; password: string }[] = [
  { email: 'sam@shop.demo', name: 'Sam Okonkwo', password: 'refund-demo-2026' },
  { email: 'priya@shop.demo', name: 'Priya Raman', password: 'refund-demo-2026' },
  { email: 'dana@shop.demo', name: 'Dana Whitfield', password: 'refund-demo-2026' },
];

/**
 * Fills the catalogue and the demo accounts, creating them only if absent.
 *
 * Idempotent like the scenario seed, because `pnpm dev` runs this on every boot
 * and a catalogue that resets on restart would be maddening. Existing products
 * have their copy and prices refreshed, but their stock is left alone - a boot
 * must not un-sell anything a checkout already sold.
 */
export function seedShop(db: Db, now: Date): { products: number; accounts: number } {
  for (const product of CATALOGUE) {
    insertProduct(db, product);
  }

  let accounts = 0;
  for (const account of DEMO_ACCOUNTS) {
    const existing = db
      .prepare('SELECT id FROM shop_users WHERE email = ?')
      .get(account.email) as { id: string } | undefined;
    if (existing !== undefined) {
      continue;
    }
    const user = createUser(
      db,
      { email: account.email, password: account.password, name: account.name, isDemo: true },
      now,
    );
    // Past orders, so "report a problem" has something to point at before the
    // tester has bought anything themselves.
    placeDemoOrders(db, user.customerId, now);
    accounts += 1;
  }

  return { products: CATALOGUE.length, accounts };
}

/** Each demo shopper's starting order history: one delivered, one in transit. */
const DEMO_ORDERS: readonly { lines: readonly { productId: string; quantity: number }[]; delivered: boolean }[] =
  [
    { lines: [{ productId: 'PRD-LAMP-01', quantity: 1 }], delivered: true },
    { lines: [{ productId: 'PRD-MUG-01', quantity: 2 }], delivered: false },
  ];

function placeDemoOrders(db: Db, customerId: string, now: Date): void {
  DEMO_ORDERS.forEach((demo, index) => {
    // Ordered far enough apart that the order dates differ, which is what makes
    // the "which order did you mean?" question meaningful in a demo.
    const placedAt = new Date(now.getTime() - (index + 1) * 9 * 24 * 60 * 60 * 1000);
    const order = checkout(db, customerId, demo.lines, placedAt);

    if (demo.delivered) {
      // Stand in for the fulfilment step having happened. A checkout cannot
      // honestly mark its own order delivered, but a demo needs an order in that
      // state to point a refund request at.
      db.prepare(
        `UPDATE orders
            SET status = 'delivered', delivered_at = ?, tracking_status = 'delivered',
                condition_at_delivery = 'sealed'
          WHERE id = ?`,
      ).run(new Date(placedAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(), order.id);
    }
  });
}
