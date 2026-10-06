import { asksForMoney, wantsAnAgent } from './intent.js';
import { scanForInjection } from '../security/injection.js';

/**
 * Which conversation this message belongs in: the refund pipeline or the
 * shopping assistant (ADR 0005).
 *
 * Deterministic and conservative by design. Anything that could be a claim
 * about money reads as `refund`, because the cost of the two mistakes is not
 * symmetric: a shopping question answered by the refund pipeline costs one
 * clarification, while a refund claim answered with product cards costs the
 * audit trail a decision that was never made.
 *
 * Three rules give that asymmetry its shape:
 *
 * - A person request is always `refund`. The pipeline force-escalates it, and
 *   this router must not swallow the one answer that has to be honoured.
 * - A money ask is always `refund`, even when it wears logistics wording.
 *   "I want to return this for a refund" is a refund request, not a
 *   parcel question; `asksForMoney` already reads "return" that way and this
 *   router does not second-guess it. The one exception is a whole-message
 *   policy question ("what is your return policy"), which names no basket and
 *   is answered from the published policy instead.
 * - A flagged policy-override attempt is always `refund`. R-14 owns that
 *   input, and a shop answer to an injection probe would be a second reader
 *   of a hostile document.
 * - Only a social-only message is a `greeting`. "Thanks, and the mug is
 *   broken" still reads as a claim, because the fault check runs first.
 * - Only an explicitly general question is `general`. An unclear message stays
 *   `refund`: the pipeline clarifies or escalates, while a chat answer would
 *   guess. The default is a person, never a paragraph.
 */
export type ShopIntent = 'refund' | 'order_status' | 'return_help' | 'product_help' | 'greeting' | 'general';

/** Question-shaped tracking language. Bare "delivered/arrived" is excluded on
 * purpose: "never arrived" is a missing-item complaint, not a status check. */
const STATUS_PATTERNS: readonly RegExp[] = [
  /\bwhere (is|are|'s) (my|the|our)\b/i,
  /\btrack(ing|ed)?\b/i,
  /\btracking (number|id|code|link)\b/i,
  /\border\b[^.?!]{0,24}\bshipped\b/i,
  /\bhas (it|my|the) (shipped|been sent|left)\b/i,
  /\bwhen will it (arrive|come|ship|be delivered)\b/i,
  /\bstatus of my order\b/i,
  /\bin transit\b/i,
  /\bout for delivery\b/i,
];

/** Parcel logistics without a money ask.
 *
 * Only phrasing that avoids the word "return" can land here: the consent bar
 * in `intent.ts` reads bare "return" as asking for money back, so "where is
 * the return label" stays `refund` and the pipeline clarifies it. Every entry
 * below is logistics the money ask cannot hear. */
const RETURN_PATTERNS: readonly RegExp[] = [
  /\bsend (it|this|them|that) back\b/i,
  /\bship (it|this|them|that) back\b/i,
  /\bhow (do i|to) send (it|this) back\b/i,
  /\bwhere do i (send|ship)\b/i,
  /\bdrop[- ]off\b/i,
];

/** Fault and complaint language. A message that says what went wrong is a
 * claim even in shopping mode, so the engine still sees it first. */
const FAULT_PATTERNS: readonly RegExp[] = [
  /\bdamag(ed|e|s)?\b/i,
  /\bbroken\b/i,
  /\bcrack(ed|ing|s)?\b/i,
  /\bfaulty\b/i,
  /\bdefect(ive)?\b/i,
  /\bwrong (item|size|colou?r|product|order)\b/i,
  /\bmissing\b/i,
  /\bnever (arrived|came|showed)\b/i,
  /\bcharged twice\b/i,
  /\bdouble charg(e|ed)\b/i,
  /\bdidn'?t (arrive|come|work)\b/i,
  /\bstopped working\b/i,
];

/** Browsing language: assortment, price, advice. */
const PRODUCT_PATTERNS: readonly RegExp[] = [
  /\bdo you (sell|have|carry|stock|offer)\b/i,
  /\brecommend(ation)?\b/i,
  /\bsuggest\b/i,
  /\blooking for\b/i,
  /\bhow much (is|does|do)\b/i,
  /\bprice of\b/i,
  /\bcost of\b/i,
  /\bcompare\b/i,
  /\bwhich .* (should|best|better)\b/i,
  /\bin stock\b/i,
];

/**
 * A message that is nothing but small talk, or nothing at all.
 *
 * Anchored on the whole message: any content beyond the courtesy falls
 * through to the checks below. Empty, whitespace, and bare punctuation count,
 * because a blank send is a customer waiting for the assistant to start.
 */
const SOCIAL_ONLY: readonly RegExp[] = [
  /^\s*$/u,
  /^[.\s!?,…—-]+$/u,
  /^\s*(hi|hiya|hey|hello|yo|good\s?(morning|afternoon|evening|day))\s*[!.,]*\s*$/i,
  /^\s*(thanks|thank\s?you|thx|ty|much\s?appreciated)\s*[!.,]*\s*$/i,
  /^\s*(bye|goodbye|good\s?night|see\s?you|cheers)\s*[!.,]*\s*$/i,
  /^\s*(ok|okay|sure|cool|great|nice)\s*[!.,]*\s*$/i,
];

/**
 * Abstract policy questions, matched on the whole message.
 *
 * Anchored and order-free on purpose: "what is your return policy" names no
 * basket, so answering it from the published policy moves no money. Anything
 * claim-shaped - "can I return this mug", "I want to return this" - cannot
 * match an anchored pattern and stays a money ask below. Checked after fault
 * (a fault anywhere makes it a claim) and before money (the consent bar would
 * otherwise hear "return" and stop this from ever firing).
 */
const POLICY_QUESTION: readonly RegExp[] = [
  /^\s*what('s| is) (your|the) (return|refund|exchange|warranty|shipping) polic(y|ies)\??\s*$/i,
  /^\s*how long (do i have|is the (return )?window)( to return)?\??\s*$/i,
  /^\s*do you (ship|deliver) (to|internationally|outside|abroad)\??\s*$/i,
  /^\s*what are your store hours\??\s*$/i,
];

/**
 * Explicitly general questions with no money words in them.
 *
 * Each names the service rather than an order. "Can I return this mug" cannot
 * match here - and must not: it is claim-shaped. Unclear messages still fall
 * through to `refund` below, so the default stays a person, never a paragraph.
 */
const GENERAL_PATTERNS: readonly RegExp[] = [
  /\bwhat can you do\b/i,
  /\bhow does this (work|shop|service|store)\b/i,
  /\bstore hours\b/i,
  /\bcontact (support|you)\b/i,
];

/**
 * Routes one message. `shoppingMode` is the client's toggle: when the customer
 * chose the shopping surface and nothing above fired, the message is a
 * browsing question rather than a claim-shaped mystery for the pipeline.
 */
export function classifyShopIntent(message: string, shoppingMode: boolean): ShopIntent {
  return claimIntent(message) ?? topicIntent(message, shoppingMode);
}

/**
 * Anything that could be a claim about money, a person request, or an attack.
 *
 * Non-null means the refund pipeline owns the message. The order is the
 * safety property: fault beats the policy carve-out (a fault anywhere makes
 * it a claim), and the carve-out beats the money ask (the consent bar would
 * otherwise hear "return" in "what is your return policy" first).
 */
function claimIntent(message: string): ShopIntent | null {
  if (wantsAnAgent(message)) {
    return 'refund';
  }
  if (scanForInjection(message).detected) {
    return 'refund';
  }
  if (FAULT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'refund';
  }
  if (POLICY_QUESTION.some((pattern) => pattern.test(message))) {
    return 'general';
  }
  if (asksForMoney(message)) {
    return 'refund';
  }
  return null;
}

/**
 * What a non-claim message is about, by topic.
 *
 * Runs only after `claimIntent` declined it, so every branch here answers
 * something the refund pipeline must never see. The default stays `refund`:
 * an unclear message escalates to a person rather than earning a paragraph.
 */
function topicIntent(message: string, shoppingMode: boolean): ShopIntent {
  // Courtesy, and only courtesy: the patterns above already kept anything
  // claim-shaped out, so what remains here asked for nothing.
  if (SOCIAL_ONLY.some((pattern) => pattern.test(message))) {
    return 'greeting';
  }
  // Return logistics before status: "where is the return label" is a parcel
  // question wearing a where-is sentence.
  if (RETURN_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'return_help';
  }
  if (STATUS_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'order_status';
  }
  // General questions before browsing: in shopping mode every fallback is
  // `product_help`, so an explicitly general question must be claimed first
  // or it would be answered from the catalogue instead of from the policy.
  if (GENERAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'general';
  }
  if (PRODUCT_PATTERNS.some((pattern) => pattern.test(message)) || shoppingMode) {
    return 'product_help';
  }
  return 'refund';
}
