import type { Db } from '../db/connection.js';
import { createUser } from './auth.js';
import { insertProduct, type Product } from './catalogue.js';

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
  {
    id: 'PRD-PIN-01',
    name: 'Waypoint Enamel Pin Set',
    blurb: 'The cheapest thing here, for watching tiny refund amounts',
    description:
      'Three enamel pins on a backing card. At nine dollars the refund is small enough that the amount maths is the whole story, with nothing else for the policy to find. That makes it the cleanest baseline for checking a refund is computed rather than guessed.',
    priceCents: 900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 500,
    testsPolicy: 'R-04 faulty goods',
    imageHue: 12,
  },
  {
    id: 'PRD-NOTEBOOK-01',
    name: 'Field Notes Notebook (3-pack)',
    blurb: 'Everyday paper goods that no rule treats specially',
    description:
      'Three pocket notebooks. An ordinary low-value purchase with no final-sale flag, no download, no subscription and nothing to seal, so the only things that can decide it are the general window and the customer’s own words.',
    priceCents: 1400,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 400,
    testsPolicy: null,
    imageHue: 96,
  },
  {
    id: 'PRD-TOTE-01',
    name: 'Harbour Canvas Market Tote',
    blurb: 'A plain item a step up from the mug, for checking the amount scales',
    description:
      'A heavy cotton tote. Like the mug it is an ordinary physical item, but a little dearer, so it is a second data point for whether the refund amount tracks the item rather than a single hard-coded figure.',
    priceCents: 3600,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 200,
    testsPolicy: 'R-04 faulty goods',
    imageHue: 200,
  },
  {
    id: 'PRD-KETTLE-01',
    name: 'Copper Pour-Over Kettle',
    blurb: 'Mid-range, comfortably under the review threshold',
    description:
      'A stovetop pour-over kettle in copper. Well below the $500 human-review threshold, so a valid refund on it should still come back as a decision the engine is allowed to make rather than being handed to a person.',
    priceCents: 8900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 60,
    testsPolicy: 'R-04 faulty goods',
    imageHue: 24,
  },
  {
    id: 'PRD-CAMERA-01',
    name: 'Lumen Instant Camera',
    blurb: 'Electronics that arrive in a sealed carton',
    description:
      'An instant camera in a sealed retail box. As with the headphones, a fault claim is only straightforward while the packaging is intact, so it is a second way to watch the condition rules bite.',
    priceCents: 15900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 25,
    testsPolicy: 'R-06 sealed packaging must be intact',
    imageHue: 340,
  },
  {
    id: 'PRD-CHAIR-01',
    name: 'Ash Lounge Chair (final sale)',
    blurb: 'Expensive and final sale — the pair that makes the threshold re-check fire',
    description:
      'A solid ash lounge chair, discounted and marked final sale. It is expensive on purpose. Bought alongside a cheap item, the order total sits over the $500 review threshold while the eligible remainder does not — the one combination that makes rule R-03b fire, which is the proof the engine re-checks the threshold after striking an item out.',
    priceCents: 62000,
    finalSale: true,
    digital: false,
    isSubscription: false,
    stock: 4,
    testsPolicy: 'R-02 final sale is not refundable',
    imageHue: 30,
  },
  {
    id: 'PRD-ESPRESSO-01',
    name: 'Vantage Espresso Machine',
    blurb: 'Over the review threshold on its own',
    description:
      'A dual-boiler espresso machine. A single one of these costs more than the $500 human-review threshold, so a valid claim must escalate for a person to approve rather than being paid by the engine alone.',
    priceCents: 79900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 8,
    testsPolicy: 'R-03 human review above threshold',
    imageHue: 20,
  },
  {
    id: 'PRD-MONITOR-01',
    name: 'Orion 5K Studio Monitor',
    blurb: 'The most expensive thing in the shop',
    description:
      'A 27-inch 5K display. The top of the range, and the clearest test that the review threshold is a floor and not a ceiling: however large the eligible amount, the engine still refuses to be the one that approves it.',
    priceCents: 129900,
    finalSale: false,
    digital: false,
    isSubscription: false,
    stock: 6,
    testsPolicy: 'R-03 human review above threshold',
    imageHue: 260,
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
 * Fills the storefront catalogue, creating products only if absent, and returns
 * how many items it wrote.
 *
 * This is the *only* seed the product ships with: the shop items are what a
 * fresh deployment needs to be browsable and buyable, and nothing else. There
 * are no demo customers, orders or history behind it, so anything that appears
 * in the system afterwards is something a real person did.
 *
 * Idempotent, and existing products have their copy and prices refreshed while
 * their stock is left alone - a seed must not un-sell what a checkout already
 * sold.
 */
export function seedCatalogue(db: Db): number {
  for (const product of CATALOGUE) {
    insertProduct(db, product);
  }
  return CATALOGUE.length;
}

/**
 * The catalogue plus the demo accounts.
 *
 * Kept for tests, which need a populated storefront with someone to sign in as.
 * The accounts start with no orders on purpose: an order a tester did not place
 * is a fake, and a refund conversation about it proves nothing. It is also
 * deliberately *not* what the `seed` command runs - shipping mock shoppers into
 * a fresh deployment is the thing the catalogue/accounts split exists to prevent.
 */
export function seedShop(db: Db, now: Date): { products: number; accounts: number } {
  const products = seedCatalogue(db);

  let accounts = 0;
  for (const account of DEMO_ACCOUNTS) {
    const existing = db
      .prepare('SELECT id FROM shop_users WHERE email = ?')
      .get(account.email) as { id: string } | undefined;
    if (existing !== undefined) {
      continue;
    }
    createUser(
      db,
      { email: account.email, password: account.password, name: account.name, isDemo: true },
      now,
    );
    accounts += 1;
  }

  return { products, accounts };
}
