/**
 * Keyword matching against what a customer actually bought.
 *
 * The problem this solves is not search, it is *not guessing*. "I bought this
 * lamp for $300, I want a refund" contains no order id, and a system that
 * guesses at that moment will eventually pick the wrong order - refunding an
 * item the customer is happy to keep, or refusing a genuine claim because the
 * order it picked is outside the window.
 *
 * So identification here is deterministic and grounded in the customer's own
 * purchase history. Their words are matched against the product names in their
 * real orders, which means a match is evidence about *their* data rather than
 * the model's opinion. A unique match resolves. Anything else escalates.
 *
 * Two consumers, one implementation:
 *  - `identifyOrder` uses it to find which order is meant.
 *  - `scopeItems` uses it to find which *items* are in dispute, which is what
 *    stops a single broken television refunding the whole basket.
 */

import type { OrderItemRecord, OrderRecord } from '../db/records.js';

/**
 * Words too common to identify a product. "I want a refund for the order I
 * placed" mentions none of these, and matching on any of them would make every
 * order look like every other one.
 */
const WEAK_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'has', 'had', 'have',
  'item', 'order', 'orders', 'purchase', 'purchased', 'bought', 'buy', 'thing',
  'stuff', 'please', 'want', 'need', 'would', 'like', 'one', 'two', 'three',
  'some', 'from', 'you', 'your', 'our', 'its', 'it', 'my', 'me', 'a', 'an', 'of',
  'to', 'in', 'on', 'at', 'is', 'are', 'be', 'do', 'did', 'can', 'could', 'refund',
  'return', 'money', 'back', 'sent', 'send', 'paid', 'pay', 'cost', 'bought',
]);

/**
 * Retail synonyms, mapped onto one canonical term per product.
 *
 * Deliberately small and hand-written. A customer's own words rarely match a
 * catalogue name - nobody types "NOVA 43 inch television" - so without this the
 * matcher only works for people who read the product listing back to us.
 *
 * Every alias is a word a person would plausibly use. Adding a speculative pair
 * costs a false match, and a false match here is a wrong order.
 */
const CANONICAL_TERMS: Readonly<Record<string, readonly string[]>> = {
  television: ['tv', 'tvs', 'telly', 'flatscreen'],
  shoes: ['shoe', 'sneaker', 'sneakers', 'trainer', 'trainers', 'footwear'],
  laptop: ['computer', 'notebook', 'macbook'],
  phone: ['smartphone', 'mobile', 'iphone'],
  headphones: ['headset', 'earphones', 'headphone'],
  sofa: ['couch'],
  lamp: ['light', 'lighting', 'lampshade'],
  bag: ['handbag', 'backpack', 'purse', 'tote'],
  mug: ['mugs', 'cup', 'cups'],
  shirt: ['tshirt', 'tee', 'blouse', 'top'],
  trousers: ['jeans', 'pants', 'slacks'],
  watch: ['wristwatch', 'smartwatch'],
  printer: ['printer', 'scanner'],
  fridge: ['refrigerator', 'freezer'],
  vacuum: ['hoover', 'vacuumcleaner'],
};

const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = buildAliasMap();

function buildAliasMap(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CANONICAL_TERMS)) {
    map.set(canonical, canonical);
    for (const alias of aliases) {
      map.set(alias, canonical);
    }
  }
  return map;
}

/** Lowercase word tokens, with punctuation and anything non-informative dropped. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !WEAK_WORDS.has(word));
}

/** Folds a word onto the canonical product term, if it is one we know. */
export function canonical(token: string): string {
  return ALIAS_TO_CANONICAL.get(token) ?? token;
}

/** The set of words that identify one product, including its synonyms. */
export function termsFor(item: OrderItemRecord): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const token of tokenize(item.name)) {
    const folded = canonical(token);
    terms.add(folded);
    for (const alias of CANONICAL_TERMS[folded] ?? []) {
      terms.add(alias);
    }
  }
  return terms;
}

/** What the customer said, folded the same way. */
export function messageTerms(message: string): ReadonlySet<string> {
  return new Set(tokenize(message).map(canonical));
}

export interface ItemMatch {
  readonly item: OrderItemRecord;
  /** Distinctive terms from the customer's message found in this product's name. */
  readonly matchedTerms: readonly string[];
}

export interface OrderMatch {
  readonly order: OrderRecord;
  readonly matches: readonly ItemMatch[];
  /** Total matched terms across the order. More evidence, higher score. */
  readonly score: number;
}

export interface MatchResult {
  /** Orders that matched, strongest first. */
  readonly matches: readonly OrderMatch[];
  /** Terms the customer used that we recognised as products. */
  readonly recognised: readonly string[];
}

/**
 * Ranks a customer's orders by how well their own product names explain what
 * they wrote. This is the "pull the shopping history" step: nothing here comes
 * from the model, and nothing here is a guess.
 */
export function matchOrders(
  orders: readonly OrderRecord[],
  message: string,
): MatchResult {
  const said = messageTerms(message);
  const matches = orders
    .map((order) => rankOrder(order, said))
    .filter((match): match is OrderMatch => match.score > 0)
    .sort((left, right) => right.score - left.score);

  const recognised = orders
    .flatMap((order) => order.items)
    .flatMap((item) => [...termsFor(item)].filter((term) => said.has(term)));

  return { matches, recognised: [...new Set(recognised)].sort() };
}

function rankOrder(order: OrderRecord, said: ReadonlySet<string>): OrderMatch {
  const matches = order.items
    .map((item) => rankItem(item, said))
    .filter((match): match is ItemMatch => match.matchedTerms.length > 0);
  const score = matches.reduce((total, match) => total + match.matchedTerms.length, 0);
  return { order, matches, score };
}

function rankItem(item: OrderItemRecord, said: ReadonlySet<string>): ItemMatch {
  const matchedTerms = [...termsFor(item)]
    .filter((term) => said.has(term))
    .sort();
  return { item, matchedTerms };
}

/**
 * Decides whether the strongest match is trustworthy.
 *
 * Unique evidence only. One order matching is a match; a clear runaway lead is
 * acceptable; two orders on the same score is a coin flip, and a coin flip that
 * ends in a refund is not a decision. `null` means "ask a person", and every
 * caller treats it that way.
 */
export function confidentMatch(result: MatchResult): OrderMatch | null {
  const [best, runnerUp] = result.matches;
  if (best === undefined) {
    return null;
  }
  if (runnerUp === undefined || best.score > runnerUp.score) {
    return best;
  }
  // Equal scores are a coin flip, and a coin flip that ends in a refund is not
  // a decision: the caller escalates (or, with a model attached, asks).
  return null;
}

/**
 * The items the customer appears to be *complaining about*, across all orders.
 *
 * Mentioning a product is not the same as claiming it. "Only the mug arrived
 * broken, the lamp is fine" names both, and reading the whole basket as the
 * claim turns a $48 dispute into a $177 refund - money handed back for an item
 * the customer explicitly said was fine. So a mention that sits in a clause
 * also describing the item as intact is dropped.
 *
 * This is a heuristic and the tests pin its edges, because the cost of being
 * wrong is asymmetric: refunding too much is worse than refunding too little,
 * which the resolver turns into an escalation rather than a payment.
 */
export function scopeItems(result: MatchResult, message?: string): readonly OrderItemRecord[] {
  const mentioned = result.matches.flatMap((match) => match.matches);
  const claimed = message === undefined ? mentioned : mentioned.filter((m) => !isRuledOut(m.item, message));
  return claimed.map((matched) => matched.item);
}

/**
 * Words that put a product outside the claim.
 *
 * Deliberately not a general negation parser. These are the phrases people
 * actually use to say an item is fine, and each one has to share a clause with
 * the product for it to count.
 */
const INTACT_MARKERS: readonly string[] = [
  'is fine',
  'was fine',
  'are fine',
  'were fine',
  'is perfect',
  'was perfect',
  'are perfect',
  'is great',
  'is good',
  'was good',
  'works fine',
  'working fine',
  'no problem',
  'no issues',
  'is intact',
  'arrived intact',
  'is undamaged',
  'is untouched',
  'no complaints',
  'happy with',
];

/** Splits a message into clauses, so a verdict about one item stays with it. */
function clausesOf(message: string): readonly string[] {
  return message
    .toLowerCase()
    // Commas, sentence ends, and the conjunctions people use to switch subject.
    .split(/[,.;!?]|\bbut\b|\bhowever\b|\balthough\b|\bthough\b|\bwhile\b|\band\b|\bwhereas\b/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** True when every clause mentioning this item also calls it intact. */
function isRuledOut(item: OrderItemRecord, message: string): boolean {
  const aliases = aliasesFor(item);
  if (aliases.length === 0) {
    return false;
  }
  const mentions = clausesOf(message).filter((clause) => aliases.some((alias) => clause.includes(alias)));
  if (mentions.length === 0) {
    return false;
  }
  // Every mention is exculpatory, so the product was named only to be ruled out.
  return mentions.every((clause) => INTACT_MARKERS.some((marker) => clause.includes(marker)));
}

/**
 * The words a product can be referred to by, reusing `termsFor` so a negation
 * test can never disagree with the matching that found the mention in the first
 * place.
 */
function aliasesFor(item: OrderItemRecord): readonly string[] {
  return [...termsFor(item)];
}

/** Human-readable evidence for the audit trail. Never guesses, only reports. */
export function describeMatch(match: OrderMatch | null, result: MatchResult): string {
  if (match === null) {
    const count = result.matches.length;
    return count === 0
      ? 'no product in the shopping history matches the message'
      : `ambiguous: ${count} orders match on product words, none chosen - needs a person`;
  }
  const terms = match.matches
    .flatMap((item) => item.matchedTerms)
    .filter((term, index, all) => all.indexOf(term) === index)
    .sort();
  return `matched order ${match.order.id} on [${terms.join(', ')}] (${match.score} term(s))`;
}
