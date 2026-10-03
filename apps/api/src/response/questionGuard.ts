/**
 * The deterministic floor under the model's clarifying questions.
 *
 * A small model is allowed to ask the customer anything it needs, but two of its
 * habits are not worth letting through: opening with a canned greeting instead
 * of acknowledging the complaint, and asking for an order number the system has
 * already resolved. Both make the assistant read as a script and drag out the
 * conversation, and both are recognisable by pattern rather than by judgement.
 *
 * The prompt forbids them; this guard makes the forbidding hold even when the
 * model is having a bad day. Three outcomes, and the caller cannot confuse them:
 *
 *  - `publish` - the question is a real question; send it verbatim.
 *  - `replace` - the question is a greeting or an order-number demand. The
 *    customer gets a warm restatement instead, composed from what the pipeline
 *    actually knows.
 *  - `escalate` - the question repeats one that was already asked in this
 *    conversation. Endless clarify loops are how the messenger loop degrades,
 *    so a repeat hands the thread to a person instead.
 */

import type { DialogueLine } from '../ai/analyzer.js';

/** Phrases that open a call-centre loop rather than engage with a complaint. */
import { alreadyAsked, nextMissingField, questionForField, type NextQuestionInput } from './nextQuestion.js';

const CUSTOMER_FACING_QUEUE_STARTERS =
  /(how can i help you today|how (?:may|can) i (?:help|assist)|welcome|what can i do for you|is there (?:anything|something) (?:else )?i can help you with)/i;

/** Direct demands for an identifier the pipeline has already resolved. */
const ORDER_NUMBER_DEMANDS =
  /(your order number|the order number|an order number|order id|order reference|which order (?:number|id))|please (?:provide|send|give) (?:me )?(?:your|the|an) order/i;

export interface QuestionGuardContext {
  /** The order was already resolved, so an order-number question is redundant. */
  readonly orderResolved: boolean;
  /**
   * Everything the assistant has said in this conversation so far, so a question
   * that has already been asked can be recognised. The agent's own composed
   * replies live here too; a short model question will not collide with them in
   * practice, and the cost of a rare collision is a safe escalation.
   */
  readonly priorAssistantText: readonly string[];
  /**
   * The thread's facts, so a vague question can be replaced with a specific one.
   *
   * Optional so a caller that has nothing but strings can still use the guard; the
   * generic restatement is then what it falls back to, which is what it did always.
   */
  readonly next?: NextQuestionInput;
}

export type RefinedQuestion =
  | { readonly kind: 'publish'; readonly question: string }
  | { readonly kind: 'replace'; readonly question: string }
  | { readonly kind: 'escalate' };

/**
 * The gate on everything the customer is asked.
 *
 * The logic is an inversion, and it has to be: publish a model's question only when it
 * asks for the field the thread is actually missing. The earlier version did the
 * opposite - replace a list of known-bad questions - and it did not work, because the
 * list is a list of phrasings somebody guessed. "What's the problem with the item?" is
 * not on it, "Tell me a little about what happened" is not on it, and both are exactly
 * the vague question the onion exists to replace. Matching on phrasing can only ever
 * catch the phrasings already thought of.
 *
 * So the question is compared against the *field* instead. If the thread is missing the
 * reason and the model's question does not ask for the reason, the question is replaced
 * by one that does - whether or not it was on any list.
 */
export function refineQuestion(raw: string, ctx: QuestionGuardContext): RefinedQuestion {
  const normalized = normalize(raw);

  if (priorQuestions(ctx.priorAssistantText).some((earlier) => normalize(earlier) === normalized)) {
    return { kind: 'escalate' };
  }

  const targeted = targetedQuestion(ctx.next);
  // `alreadyAsked` is a similarity test, which is what "does this question ask for the
  // thing we are missing" needs: it is true when the model's words and the targeted
  // question are about the same field, so a specific question survives untouched.
  if (targeted !== null && !alreadyAsked(targeted, [raw])) {
    return { kind: 'replace', question: targeted };
  }

  if (isCanned(raw) || (ctx.orderResolved && demandsOrderNumber(raw))) {
    return { kind: 'replace', question: targeted ?? warmRestatement(ctx.orderResolved) };
  }
  return { kind: 'publish', question: raw };
}

/**
 * The question for whatever the thread is still missing, or null when it cannot be
 * named - no order, nothing the customer has said, or a question already asked.
 */
function targetedQuestion(next: NextQuestionInput | undefined): string | null {
  if (next === undefined) {
    return null;
  }
  const field = nextMissingField(next);
  return field === null ? null : questionForField(field, next);
}

/**
 * The fallback when the thread's missing field cannot be named.
 *
 * Kept as a last resort rather than the default, and deliberately vaguer than the
 * targeted questions: reaching it means the thread is in a state this file cannot
 * describe, and saying less is the honest response to that.
 */
function warmRestatement(orderResolved: boolean): string {
  if (!orderResolved) {
    return (
      'Thanks for getting in touch. I did not have enough to find the right order, so could you ' +
      'tell me the name of the product, the date you ordered, or the email address you used?'
    );
  }
  return 'Just to make sure I have understood you - could you tell me a bit more about what happened with the order and what you would like me to do?';
}

function isCanned(question: string): boolean {
  return CUSTOMER_FACING_QUEUE_STARTERS.test(question);
}

function demandsOrderNumber(question: string): boolean {
  return ORDER_NUMBER_DEMANDS.test(question);
}

function priorQuestions(assistantText: readonly string[]): readonly string[] {
  return assistantText;
}

/** Lowercased, punctuation stripped, whitespace collapsed, for repeat matching. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The assistant's own words out of a transcript, for the repeat check. */
export function assistantLines(history: readonly DialogueLine[]): readonly string[] {
  return history.filter((line) => line.role === 'assistant').map((line) => line.text);
}