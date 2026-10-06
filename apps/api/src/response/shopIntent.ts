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
 *   router does not second-guess it.
 * - A flagged policy-override attempt is always `refund`. R-14 owns that
 *   input, and a shop answer to an injection probe would be a second reader
 *   of a hostile document.
 */
export type ShopIntent = 'refund' | 'order_status' | 'return_help' | 'product_help';

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
 * Routes one message. `shoppingMode` is the client's toggle: when the customer
 * chose the shopping surface and nothing above fired, the message is a
 * browsing question rather than a claim-shaped mystery for the pipeline.
 */
export function classifyShopIntent(message: string, shoppingMode: boolean): ShopIntent {
  if (wantsAnAgent(message)) {
    return 'refund';
  }
  if (scanForInjection(message).detected) {
    return 'refund';
  }
  if (asksForMoney(message) || FAULT_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'refund';
  }
  // Return logistics before status: "where is the return label" is a parcel
  // question wearing a where-is sentence.
  if (RETURN_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'return_help';
  }
  if (STATUS_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'order_status';
  }
  if (PRODUCT_PATTERNS.some((pattern) => pattern.test(message)) || shoppingMode) {
    return 'product_help';
  }
  return 'refund';
}
