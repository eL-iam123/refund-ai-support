/**
 * Did the customer say what they want, or did we work it out?
 *
 * The assistant is good at inference and that is the problem. "the colour is blue, I
 * wanted red" describes a preference, not a fault, and not a request for money - but a
 * model asked to classify intent will fill in `refund`, connect it to a damaged item,
 * and the policy will approve it. Seen live: a customer said the notebook was the wrong
 * colour, was asked what was wrong with it, answered, and was refunded $14.00 having
 * never asked for a refund.
 *
 * So the bar for moving money is not "we understood" but "**they asked**". Everything
 * here is deliberately small and explicit: a short list of the ways people ask for money
 * back, and a short list of the ways they say yes. Anything subtler would be guessing,
 * and the whole point is to stop guessing.
 */

/**
 * The ways a customer asks for their money back, in the words people actually use.
 *
 * Includes "return" because "I would like to return this" is a refund request in every
 * language this system reads, and "money back" because "I want my money back" is the
 * most common phrasing there is. Deliberately not exhaustive: a phrase this list misses
 * costs one extra question, while a phrase it wrongly matches costs a customer's
 * refusal being treated as consent.
 */
const ASKS_FOR_MONEY: readonly RegExp[] = [
  /\brefund(ed)?\b/i,
  /\breimburse(ment|d)?\b/i,
  /\breturn(ing|ed)?\b/i,
  /\bmoney back\b/i,
  /\bmy money\b/i,
  /\bgive me my\b/i,
  /\bpay me back\b/i,
  /\breversed?\b.*\b(payment|charge)\b/i,
  /\bcharge ?back\b/i,
  /\bcompensat(e|ion)\b/i,
];

/** The ways a customer says yes to what we just asked them. */
const SAYS_YES: readonly RegExp[] = [
  /^\s*yes\b/i,
  /^\s*yep\b/i,
  /^\s*yeah\b/i,
  /^\s*that'?s right\b/i,
  /^\s*correct\b/i,
  /^\s*exactly\b/i,
  /^\s*that'?s (it|what)\b/i,
  /^\s*please do\b/i,
  /^\s*go ahead\b/i,
  /^\s*do it\b/i,
  /^\s*sure\b/i,
];

/** Whether the customer's own words ask for money back. */
export function asksForMoney(text: string): boolean {
  return ASKS_FOR_MONEY.some((pattern) => pattern.test(text));
}

/**
 * Whether the customer is agreeing with the question we just put to them.
 *
 * Read only from the turn *immediately after* a confirmation, and only from the
 * customer's side. An assistant turn saying "yes" is the model agreeing with itself,
 * which is not consent.
 */
export function confirmsIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    // A paragraph is not a yes. Someone who has gone on to explain themselves has not
    // confirmed anything, and treating it as confirmation is the failure this guards.
    return false;
  }
  return SAYS_YES.some((pattern) => pattern.test(trimmed)) || asksForMoney(trimmed);
}

/**
 * Has the customer asked for a person?
 *
 * Checked before anything else, because it is the one answer that has to be honoured
 * whatever the policy would have said. A customer who wants a human must not be
 * argued out of it by a rule that would have approved - being handled by a person is
 * not a refund question, and refusing it would be the system overruling a request it
 * has no authority over.
 */
const ASKS_FOR_AN_AGENT: readonly RegExp[] = [
  /\b(speak|talk|chat)\b[^.?!]{0,24}\b(agent|person|human|someone|advisor|rep\w*)\b/i,
  /\b(agent|person|human|advisor)\b[^.?!]{0,20}\b(please|now|instead)\b/i,
  /\b(real|actual)\s+(person|human)\b/i,
  /\bpass (this|it)\b[^.?!]{0,16}\b(agent|person|human|on)\b/i,
  /\bhuman being\b/i,
  /\breal person\b/i,
  /\bmanager\b/i,
  /\bcomplain\b/i,
];

export function wantsAnAgent(text: string): boolean {
  return ASKS_FOR_AN_AGENT.some((pattern) => pattern.test(text));
}

/** Has the customer picked a refund out of the options we offered? */
export function picksRefund(text: string): boolean {
  return /\brefund(ed)?\b/i.test(text) || /\bmoney back\b/i.test(text) || /\bmy money\b/i.test(text);
}

/**
 * The only thing that says "this answer was one of the options we offered".
 *
 * Deliberately strict: the previous question is what makes a short reply a choice
 * rather than a new complaint, and without it a bare "yes" would be read as agreeing
 * to a refund nobody had mentioned.
 */
export function isChoiceAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 80;
}
