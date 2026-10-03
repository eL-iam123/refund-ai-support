import type { ClaimExtraction } from '@refund/shared';
import {
  type AIAnalyzer,
  type AnalyzerOrder,
  type IntakeInput,
  type IntakeReply,
  type AttemptObserver,
  type ChatInput,
  type ChatReply,
} from './analyzer.js';
import { scanForInjection } from '../security/injection.js';
import { isNoComplaint, noComplaintQuestion } from '../response/noComplaint.js';
import { clarifySparseDamage } from '../response/claimClarification.js';
import { readClaim } from './reasonVocabulary.js';

/**
 * The extractor that runs when there is no provider key.
 *
 * Selected with `AI_PROVIDER=local`, it is a pattern matcher rather than a
 * language model: it reads reason words, a currency figure and an item name out
 * of the message and returns them as a claim. It is genuinely useful for two
 * things - running the whole product on a machine with no credentials, and
 * exercising the deterministic policy engine on all eighteen scenarios without a
 * network - and it is never a safe substitute for a model, which is why
 * `readEnv` refuses it in production.
 *
 * The security argument is unchanged by any of that, and worth stating plainly,
 * because a weaker extractor can look like a weaker *product*. This returns a
 * claim, and a claim is a proposal. The resolver overrules it on order facts
 * alone, so the worst this class can do is make the model unavailable: every
 * request it reads is decided exactly as it would be if a provider were down.
 * It cannot widen what is refundable, and the ceiling on an automatic refund is
 * computed from keyword matching that this class does not participate in.
 *
 * The pattern set below is shared with the test suite, which is the reason it
 * lives here rather than in `src/test/`: there is one implementation of
 * "heuristic reading", tested by eighteen scenarios, used by both.
 */

const MODEL = 'local-heuristic-v1';

const EXCHANGE_INTENT = /\bexchange\b|\bswap\b|\breplace\s+it\b/i;
const NOT_REFUND = /don'?t\s+want\s+(?:a\s+)?refund|not\s+a\s+refund|refund\s+denied/i;
const URGENT = /\burgent\b|\basap\b|\bimmediately\b|\bright\s+now\b|\btoday\b|as\s+soon\s+as\s+possible/i;

/**
 * An order figure the customer named. Three shapes, because currency marks
 * appear on both sides of the number: "$450", "9000 $" and "450 USD".
 */
const CURRENCY_PATTERNS: readonly RegExp[] = [
  /[$€£]\s*(\d[\d,]*(?:\.\d{1,2})?)/,
  /(\d[\d,]*(?:\.\d{1,2})?)\s*[$€£]/,
  /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:usd|eur|gbp|dollars?|euros?)\b/i,
];

const ORDER_REFERENCE = /\bORD-\d+\b/i;
/** "the whole order", "all of it", "everything" - a figure named in words. */
const WHOLE_ORDER = /\b(?:whole order|entire order|all of (?:it|the order)|everything)\b/i;

const LANGUAGE_MARKERS: readonly { code: string; pattern: RegExp }[] = [
  { code: 'fr', pattern: /\b(?:bonjour|merci|colis|remboursement|administrateur|politique|commande|arriv[ée])\b/i },
  { code: 'es', pattern: /\b(?:hola|gracias|pedido|reembolso|env[ií]o|paquete)\b/i },
  { code: 'de', pattern: /\b(?:hallo|danke|bestellung|erstattung|lieferung)\b/i },
];

/** Words too generic to identify a product. */
const STOPWORDS = new Set(['set', 'pair', 'box', 'pack', 'and', 'the', 'for', 'with', 'size', 'kit']);

export function LocalAnalyzer(): AIAnalyzer {
  return {
    label: 'local (heuristic)',
    model: MODEL,
    available: true,
    unavailableReason: null,
    analyze(input, observer) {
      return Promise.resolve(analyzeWithHeuristics(input, observer));
    },
    chat(input, observer) {
      return Promise.resolve(chatWithHeuristics(input, observer));
    },
  };
}

/**
 * The heuristic reading, as an `IntakeReply`.
 *
 * A pattern matcher cannot hold a clarification loop open across turns, but it
 * can honour the same contract a live model is held to: a message with nothing
 * wrong in it is answered with a question rather than turned into a claim, and a
 * bare "damaged" with no observed condition is asked about before it reaches the
 * reason rules. That is why the scenario fixtures run against this class and not
 * a second copy of the pattern set.
 */
function analyzeWithHeuristics(input: IntakeInput, observer: AttemptObserver): IntakeReply {
  observer({ model: MODEL, attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });
  if (isNoComplaint(input.message)) {
    return {
      kind: 'question',
      question: noComplaintQuestion(input.message, input.order !== null),
      model: MODEL,
    };
  }
  const damageQuestion = clarifySparseDamage(input.message);
  if (damageQuestion !== null) {
    return { kind: 'question', question: damageQuestion, model: MODEL };
  }
  return {
    kind: 'complete',
    extraction: read(input),
    model: MODEL,
  };
}

function read(input: IntakeInput): ClaimExtraction {
  const message = input.message;
  const claim = readClaim(message);
  const claimed = claimedAmountCents(message);

  return {
    intent: detectIntent(message),
    reason: claim.reason,
    condition: claim.condition,
    confidence: claim.confidence,
    orderRef: ORDER_REFERENCE.exec(message)?.[0] ?? null,
    // A customer asking for "the whole order" has named an amount: the total.
    // A customer who named no figure at all has named nothing, and saying
    // otherwise would put a claim about their intentions in the audit trail
    // that they never made.
    claimedAmountCents: claimed ?? wholeOrderCents(message, input.order),
    items: mentionedItems(message, input.order?.items ?? []),
    evidenceQuotes: claim.quote === null ? [] : [claim.quote],
    language: detectLanguage(message),
    urgency: URGENT.test(message) ? 'high' : 'normal',
    policyOverrideAttempted: scanForInjection(message).detected,
  };
}

/**
 * The sentence a match was found in, exactly as the customer wrote it.
 *
 * Copying the real sentence rather than the matched fragment is what keeps the
 * grounding guarantee honest: if this returned only the regex hit, a test could
 * pass a quote the customer never actually typed.
 */

function detectIntent(message: string): ClaimExtraction['intent'] {
  if (NOT_REFUND.test(message)) {
    return 'other';
  }
  if (EXCHANGE_INTENT.test(message)) {
    return 'exchange';
  }
  // This is a refund channel, so the absence of the word "refund" is not a
  // reason to doubt the intent. S-01 approves on "it is unusable" alone.
  return 'refund';
}

function detectLanguage(message: string): string {
  for (const marker of LANGUAGE_MARKERS) {
    if (marker.pattern.test(message)) {
      return marker.code;
    }
  }
  return 'en';
}

function claimedAmountCents(message: string): number | null {
  for (const pattern of CURRENCY_PATTERNS) {
    const digits = pattern.exec(message)?.[1];
    if (digits === undefined) {
      continue;
    }
    const value = Number.parseFloat(digits.replace(/,/g, ''));
    if (Number.isFinite(value)) {
      return Math.round(value * 100);
    }
  }
  return null;
}

/** The order total, but only when the message actually asked for all of it. */
function wholeOrderCents(message: string, order: AnalyzerOrder | null): number | null {
  return order !== null && WHOLE_ORDER.test(message) ? order.totalCents : null;
}

/** Item ids whose name is actually mentioned in the message. */
function mentionedItems(message: string, items: readonly { id: string; name: string }[]): string[] {
  const haystack = message.toLowerCase();
  return items
    .filter((item) =>
      item.name.toLowerCase().split(/[^a-z0-9]+/u).some((word) => word.length >= 4 && !STOPWORDS.has(word) && haystack.includes(word)),
    )
    .map((item) => item.id);
}

/**
 * Chat mode for escalated conversations (local heuristic version).
 *
 * Provides a helpful, conversational response with no monetary authority.
 * Can use the remind_admin tool to notify the human agent.
 */
function chatWithHeuristics(input: ChatInput, observer: AttemptObserver): ChatReply {
  observer({ model: MODEL, attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });

  // Check if the customer is pushing/waiting - use remind_admin tool
  const isPushing = /(?:where|wait|waiting|anyone|hello|any\s+one|anybody|agent|human|admin|help|anyone\s+there|any\s+updates?|status|waiting|waited|long\s+time|taking\s+long|hurry|urgent|asap|immediately)/i.test(input.message);

  if (isPushing && input.tools.some(t => t.name === 'remind_admin')) {
    return {
      kind: 'tool_call',
      tool: 'remind_admin',
      model: MODEL,
    };
  }

  // Conversational responses based on message content
  const isGreeting = /^(?:hi|hello|hey|hiya|howdy|good\s+(?:morning|afternoon|evening)|hi\s+there|hey\s+there)/i.test(input.message.trim());
  const isThanks = /^(?:thanks|thank\s+you|thx|ty|thank\s+u)/i.test(input.message.trim());
  const isWaiting = /(?:wait|waiting|waited|long\s+time|taking\s+long|any\s+updates?|status|any\s+news)/i.test(input.message);
  const isFrustrated = /(?:frustrat|annoy|angry|upset|ridiculous|unacceptable|unprofessional|waste|wasting|worst)/i.test(input.message);

  let response: string;

  if (isGreeting && !isWaiting) {
    response = "Hi there! I can see you're connected with a human agent who's looking into your case. They'll be with you shortly. Is there anything else I can help with while you wait?";
  } else if (isThanks) {
    response = "You're welcome! Your agent is working on this and will update you soon. Let me know if there's anything else you need.";
  } else if (isFrustrated) {
    response = "I understand this is frustrating, and I'm sorry for the wait. Your human agent is aware and is looking into this for you. I've let them know you're waiting. Is there anything specific you'd like me to pass along?";
  } else if (isWaiting) {
    response = "I know waiting is frustrating. Your agent is still reviewing this and will get back to you as soon as they can. I've given them a nudge that you're waiting. Is there anything else I can help with in the meantime?";
  } else {
    // Default helpful response
    response = "I'm here to help while your agent works on this. They're reviewing the details and will get back to you soon. Is there anything specific you'd like me to pass along or any other questions I can answer while you wait?";
  }

  return {
    kind: 'text',
    text: response,
    model: MODEL,
  };
}
