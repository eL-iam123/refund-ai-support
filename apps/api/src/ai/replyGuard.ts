import type { PhraseEnvelope } from './analyzer.js';

/**
 * What a conversational reply may not say.
 *
 * The general model is prompted with prohibitions, but prompts are advice and
 * this is the enforcement: a reply that states an outcome, names a figure, or
 * claims knowledge of the customer's orders is discarded and the caller
 * answers deterministically instead. The check is deliberately lexical and
 * strict - a false rejection costs one canned sentence, while a false
 * acceptance puts an approval-looking claim in front of a customer that the
 * policy never made.
 *
 * Bare policy nouns stay legal on purpose: an answer explaining the exchange
 * policy has to be allowed the word "exchange". What is forbidden is outcome
 * language (approved, paid), figures, and anything addressed to *their* case.
 */

const FORBIDDEN_OUTCOME: readonly RegExp[] = [
  /\bapprov\w*\b/i,
  /\bden(y|ied)\b/i,
  /\bescalat\w*\b/i,
  /\bpaid\b/i,
  /\bwill be (refunded|paid|approved)\b/i,
  /\bon (its|the) way\b/i,
  /\bwe (approved|denied|refunded|will refund|have issued)\b/i,
  /\byour (refund|exchange|return|claim|payment)\b/i,
  /\bpartial_refund\b/i,
  /[$€£]\s?\d/,
  /\b\d+\s?(dollars|cents|usd|eur)\b/i,
];

const FORBIDDEN_FACTS: readonly RegExp[] = [
  /\border\b[^.?!]{0,30}\b(shipped|delivered|arrived|processing|placed)\b/i,
  /\btracking (number|id|code)\b/i,
  /\byour (account|order|purchase)\b/i,
  /\bi (checked|looked|can see|found) (your|the) (order|account)\b/i,
  /\bwill (arrive|ship|be delivered) (on|by|tomorrow|today|monday|tuesday|wednesday|thursday|friday)\b/i,
];

/** True when the reply stays inside the conversational contract. */
export function isSafeGeneralReply(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return ![...FORBIDDEN_OUTCOME, ...FORBIDDEN_FACTS].some((pattern) => pattern.test(text));
}

/**
 * Whether a phrased decision reply states exactly its envelope.
 *
 * Stricter than the conversational guard in one way and looser in another.
 * Stricter: every currency-like token must resolve to an allowed amount, only
 * the envelope's outcome family may appear, and every `mustSay` sentence must
 * be present verbatim - a paraphrased timeline is a different promise.
 * Looser: the phrasing may use the envelope outcome's own verbs, which the
 * conversational guard bans outright.
 *
 * Anything rejected here costs a deterministic sentence, never a customer. A
 * false rejection falls back; a false acceptance pays out a lie. The bias is
 * deliberate.
 */
export function isSafePhrasedReply(text: string, envelope: PhraseEnvelope): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  const withoutRequired = stripMustSay(text, envelope.mustSay);
  if (withoutRequired === null) {
    return false;
  }
  return amountsMatch(withoutRequired, envelope.allowedAmounts) && outcomesMatch(withoutRequired, envelope.outcome);
}

/**
 * Removes each required sentence, proving it was there verbatim.
 *
 * Case-insensitive, because capitalisation after restructuring is not a
 * different promise. Returns null when any required sentence is missing or
 * paraphrased - and removing them first means the remaining checks can ban
 * timeline and promise language without tripping over the required sentences
 * themselves.
 */
function stripMustSay(text: string, mustSay: readonly string[]): string | null {
  let remaining = text;
  for (const sentence of mustSay) {
    const at = remaining.toLowerCase().indexOf(sentence.toLowerCase());
    if (at === -1) {
      return null;
    }
    remaining = `${remaining.slice(0, at)}${remaining.slice(at + sentence.length)}`;
  }
  return remaining;
}

/** Every figure in the reply must be one the envelope allows. */
function amountsMatch(text: string, allowedAmounts: readonly string[]): boolean {
  const allowed = new Set(allowedAmounts.map(normalizeAmount));
  for (const token of moneyTokens(text)) {
    if (!allowed.has(normalizeAmount(token))) {
      return false;
    }
  }
  return true;
}

function normalizeAmount(token: string): string {
  return token.toLowerCase().replace(/[$€£\s,]/g, '');
}

/** Currency figures with symbols, figures with money words, and bare money words. */
function moneyTokens(text: string): readonly string[] {
  const tokens: string[] = [];
  const pushAll = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      if (match[0] !== undefined) {
        tokens.push(match[0]);
      }
    }
  };
  pushAll(/[$€£]\s?[\d,]+(?:\.\d{1,2})?/g);
  pushAll(/\b\d[\d,]*\.?\d*\s?(?:dollars?|cents?|usd|eur)\b/gi);
  pushAll(/\b(?:dollars?|cents?|usd|eur)\b/gi);
  return tokens;
}

/** No outcome family but the envelope's own may appear. */
function outcomesMatch(text: string, outcome: PhraseEnvelope['outcome']): boolean {
  return !RIVALS[outcome].some((pattern) => pattern.test(text)) && promisesMatch(text) && referencesMatch(text);
}

const APPROVE_MARK = /\bapprov\w*\b/i;
const DENY_MARKS: readonly RegExp[] = [/\bden(y|ied|ial)\b/i, /\brefus\w*\b/i];
const ESCALATE_MARK = /\bescalat\w*\b/i;
const PARTIAL_MARK = /\bpartial\b/i;
const EXCHANGE_MARK = /\bexchange\b/i;
const STORE_CREDIT_MARK = /store[ _]?credit/i;

/**
 * The rival markers for each outcome: any other decision's distinctive verbs.
 *
 * A partial refund may be called approved - it is a payment the engine
 * authorised - but an approval may never be called partial, denied, or
 * anything else. The asymmetry is deliberate: the harm is a reply that
 * states a decision the engine did not reach.
 */
const RIVALS: Readonly<Record<PhraseEnvelope['outcome'], readonly RegExp[]>> = {
  approved: [...DENY_MARKS, ESCALATE_MARK, PARTIAL_MARK, EXCHANGE_MARK, STORE_CREDIT_MARK],
  denied: [APPROVE_MARK, ESCALATE_MARK, PARTIAL_MARK, EXCHANGE_MARK, STORE_CREDIT_MARK],
  escalated: [APPROVE_MARK, ...DENY_MARKS, PARTIAL_MARK, EXCHANGE_MARK, STORE_CREDIT_MARK],
  partial_refund: [...DENY_MARKS, ESCALATE_MARK, EXCHANGE_MARK, STORE_CREDIT_MARK],
  exchange: [APPROVE_MARK, ...DENY_MARKS, ESCALATE_MARK, PARTIAL_MARK, STORE_CREDIT_MARK],
  store_credit: [APPROVE_MARK, ...DENY_MARKS, ESCALATE_MARK, PARTIAL_MARK, EXCHANGE_MARK],
};

/**
 * No timelines, guarantees, credentials, rule ids, or order references.
 *
 * The mustSay sentences are already stripped, so these patterns cannot
 * collide with required wording - anything left matching them is the model's
 * own invention.
 */
function promisesMatch(text: string): boolean {
  return !PHRASED_FORBIDDEN.some((pattern) => pattern.test(text));
}

const PHRASED_FORBIDDEN: readonly RegExp[] = [
  /\bon (its|the) way\b/i,
  /\bwill be (refunded|paid|approved)\b/i,
  /\bguarantee[sd]?\b/i,
  /\bpromis(e|ed|ing)\b/i,
  /\btomorrow\b/i,
  /\btoday\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday)\b/i,
  /\bpassword\b/i,
  /\bcard number\b/i,
  /\bcvv\b/i,
  /\bbank\b/i,
  /\badministrator\b/i,
  /\bR-\d\d\b/,
  /§/,
  /REFUND_POLICY/i,
  /\bORD-[A-Za-z0-9]+\b/i,
  /\bhttps?:\/\//i,
];

/** No invented order facts beyond what the envelope names. */
function referencesMatch(text: string): boolean {
  return !FORBIDDEN_FACTS.some((pattern) => pattern.test(text));
}
