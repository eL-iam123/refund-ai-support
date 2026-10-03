import { FAULTY_REASONS } from '@refund/shared';
import type { OrderRecord } from '../db/records.js';
import { detectedReason, readableCondition } from '../ai/reasonVocabulary.js';

/**
 * What to ask next, one layer at a time.
 *
 * A clarification loop only works if each turn removes one unknown. The failure is
 * always the same shape: the assistant asks "can you tell me more?", the customer
 * answers with everything they know, and the next turn asks something adjacent to what
 * they just said. Nothing converges, and the customer is eventually escalated for
 * being unclear.
 *
 * So the next question is *derived* rather than written: work out which single field
 * the thread is still missing, and ask for that field and nothing else. The order
 * below is the order the policy needs them in, and each step is a precondition for
 * the next:
 *
 *  1. **Which order** - nothing can be checked against an order nobody has named.
 *  2. **Which item** - a claim against a five-line basket is a claim against a line,
 *     and the dispute ceiling is built from lines. The picker owns this one when the
 *     model reaches for it; this is what to say when it asks about it in prose.
 *  3. **What happened** - the reason. Nothing in the policy can be evaluated without
 *     it, and it is the one thing the customer's own words are the only source of.
 *  4. **What condition it was in** - only for a claim that names a fault, where the
 *     condition decides which rule applies and whether the item is eligible at all.
 *
 * Two deliberate non-questions. The amount is never asked for, because a customer who
 * cannot say how much they paid has still told us what went wrong and the order knows
 * the figure. And nothing is asked twice: `askedAlready` is checked before every
 * question, because a repeated question is the one thing that makes a customer stop
 * answering.
 */

export type MissingField = 'order' | 'item' | 'reason' | 'condition';

export interface NextQuestionInput {
  /** The order the thread is about, or null when it has not been identified. */
  readonly order: OrderRecord | null;
  /** Lines already carrying a request or an open escalation. */
  readonly reportedItemIds: readonly string[];
  /** Everything the customer has said, oldest first, including the newest message. */
  readonly customerText: readonly string[];
  /** The assistant's own questions in this thread, so nothing is asked twice. */
  readonly askedText: readonly string[];
}

/**
 * The one thing still missing, or null when nothing is.
 *
 * Reads the customer's own words rather than the model's claim, because this runs
 * *before* there is a claim - asking what is missing is precisely the situation where
 * no claim came back. The reason table is shared with the matcher so the two cannot
 * drift apart; see `ai/reasonVocabulary.ts`.
 */
export function nextMissingField(input: NextQuestionInput): MissingField | null {
  if (input.order === null) {
    return 'order';
  }
  if (candidateLines(input).length > 1) {
    return 'item';
  }
  const said = input.customerText.join(' ');
  const reason = detectedReason(said);
  if (reason === null) {
    return 'reason';
  }
  // The condition is only worth a question for a fault: a late delivery has no
  // condition, and asking "what condition was it in?" about a delivery delay is the
  // kind of question that ends a conversation. The fault test comes from the shared
  // vocabulary rather than a list written here, so it cannot drift from the rules
  // that treat a fault as a fault.
  if (FAULTY_REASONS.includes(reason) && readableCondition(said) === 'unknown') {
    return 'condition';
  }
  return null;
}

/**
 * The question for that field, or null when it has effectively been asked before.
 *
 * `alreadyAsked` is a substring test rather than an exact one on purpose: a model
 * asking "could you tell me what condition the mug is in?" and the deterministic
 * question being "in what condition was the mug?" is the same question twice, and the
 * customer experiences it as being ignored.
 */
export function questionForField(field: MissingField, input: NextQuestionInput): string | null {
  const question = QUESTION[field](input);
  if (alreadyAsked(question, input.askedText)) {
    return null;
  }
  return question;
}

/**
 * Whether the customer has already been asked something on this thread.
 *
 * Exact containment first, then word overlap, because the repeat that matters is
 * rarely word-for-word: the assistant asks "in what condition did the mug arrive?"
 * and the deterministic question is "what condition was the mug in?" A containment
 * test misses that pair entirely, and the customer experiences it as the assistant
 * asking twice.
 *
 * Overlap is measured on the words that carry meaning - the short ones are dropped, so
 * "did", "the" and "it" cannot make two different questions look alike - and the
 * threshold is set by one pair that must merge and one that must not.
 *
 * Must merge: the condition question above and "what condition was the mug in?", which
 * share `what` and `condition` against a two-word question - all of it.
 * Must not merge: "what has gone wrong with it?" and the condition question, which
 * share only `what` - a quarter. Half is the line, and it sits between them because
 * the two mistakes are not symmetric: asking twice ends the conversation, while asking
 * a second *field* costs one turn.
 */
export function alreadyAsked(question: string | null, askedText: readonly string[]): boolean {
  if (question === null) {
    return false;
  }
  const needle = question.toLowerCase();
  return askedText.some(
    (earlier) =>
      earlier.toLowerCase().includes(needle) ||
      needle.includes(earlier.toLowerCase()) ||
      sameQuestion(needle, earlier.toLowerCase()),
  );
}

/** Fraction of the shorter question's meaningful words the longer one also has. */
const SAME_QUESTION_OVERLAP = 0.5;

function sameQuestion(left: string, right: string): boolean {
  const a = significantWords(left);
  const b = significantWords(right);
  if (a.size === 0 || b.size === 0) {
    return false;
  }
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.min(a.size, b.size) >= SAME_QUESTION_OVERLAP;
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

const QUESTION: Record<MissingField, (input: NextQuestionInput) => string> = {
  order: () =>
    'Thanks for getting in touch. I could not find the order from that - could you tell me the ' +
    'product name, the date you ordered, or the email address you used?',
  item: (input) => {
    const lines = candidateLines(input).map((line) => `${line.name} (${money(line.unitPriceCents * line.quantity)})`);
    return `Is this about ${joinList(lines)}, or a different one?`;
  },
  reason: () =>
    'Just so I check this properly - what has gone wrong with it? For example something broken, ' +
    'something different from what you ordered, a delivery problem, or a charge you did not expect.',
  condition: (input) => {
    const line = candidateLines(input)[0];
    const subject = line === undefined ? 'it' : `the ${line.name}`;
    return `In what condition did ${subject} arrive - damaged, or would you say it might have been damaged in transit?`;
  },
};

function candidateLines(input: NextQuestionInput): readonly OrderRecord['items'][number][] {
  if (input.order === null) {
    return [];
  }
  const reported = new Set(input.reportedItemIds);
  return input.order.items.filter((line) => !reported.has(line.id));
}


function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? 'that';
  }
  if (items.length === 2) {
    return `${items[0]} or ${items[1]}`;
  }
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
