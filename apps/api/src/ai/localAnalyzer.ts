import type { ClaimExtraction } from '@refund/shared';
import { AiUnavailableError, type AgentReply, type AIAnalyzer, type AnalyzerInput, type AttemptObserver, type ChatInput, type ChatReply, type ChatTool } from './analyzer.js';
import { scanForInjection } from '../security/injection.js';
import { isNoComplaint, noComplaintQuestion } from '../response/noComplaint.js';

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

interface ReasonPattern {
  readonly reason: ClaimExtraction['reason'];
  readonly condition: ClaimExtraction['condition'];
  readonly confidence: number;
  readonly patterns: readonly RegExp[];
}

/** Reason detection, in priority order. First match wins. */
const REASON_PATTERNS: readonly ReasonPattern[] = [
  {
    reason: 'duplicate_charge',
    condition: 'unknown',
    confidence: 0.88,
    patterns: [
      /charg\w+\s+(?:me\s+)?twice/i,
      /double[-\s]?charg/i,
      /two\s+charges/i,
      /duplicate\s+(?:charge|payment)/i,
      /factur\w*\s+deux\s+fois/i,
      /cobrad\w*\s+dos\s+veces/i,
    ],
  },
  {
    reason: 'missing_item',
    condition: 'missing',
    confidence: 0.72,
    patterns: [
      /never\s+(?:arrived|came|received|showed)/i,
      /(?:did|didn'?t|did\s*n[o']?t)\s+(?:arrive|come|receive|get)/i,
      /not\s+(?:arrived|delivered|received|here)/i,
      /(?:absolutely\s+)?nothing\s+(?:here|there|in\s+the\s+box)/i,
      /no\s+(?:items?|parcels?|packages?|products?)\s+(?:here|arrived|in)/i,
      /missing\s+(?:item|parcel|package|piece)/i,
      /jamais\s+re[çc]u/i,
      /no\s+lleg[óo]/i,
    ],
  },
  {
    reason: 'wrong_item',
    condition: 'incorrect',
    confidence: 0.85,
    patterns: [
      /(?:is|was|are|were)(?:n'?t|\s+not)\s+what\s+i\s+(?:ordered|asked|got|requested)/i,
      /wrong\s+(?:item|product|thing|size|colour|color|model|order)/i,
      /sent\s+me\s+the\s+wrong/i,
      /different\s+(?:item|product|model)\s+(?:than|to)/i,
      /mauvais\s+article|pas\s+le\s+m[eê]me\s+article/i,
      /art[ií]culo\s+equivocado/i,
    ],
  },
  {
    reason: 'damaged',
    condition: 'damaged',
    confidence: 0.85,
    patterns: [
      /\bdamag(?:e|ed|es|ing)\b/i,
      /crack(?:ed|s)?\b/i,
      /\bbroken\b|\bshattered\b|\bsplit\b|\bfissur/i,
      /\b(?:tear|torn|ripped)\b/i,
      /\bnot\s+working\b|\bdoes\s*n[o']?t\s+work\b|\bdefective\b|\bfaulty\b|\bmalfunction/i,
      /\bunusable\b/i,
      /endommag\w*/i,
      /d[ée]chir[ée]s?/i,
      /\bcass[ée]s?\b|\bcrev[ée]s?\b/i,
      /roto|\brota\b|da[ñn]ad[oa]/i,
      /besch[äa]digt|\bkaputt\b/i,
    ],
  },
  {
    reason: 'not_as_described',
    condition: 'possibly_damaged',
    confidence: 0.8,
    patterns: [
      /not\s+as\s+(?:described|advertised|shown|pictured|listed)/i,
      /\bmisleading\b|\bdescription\s+was\s+wrong/i,
      /nothing\s+like\s+the\s+(?:photo|picture)/i,
      /ne\s+correspond\s+pas/i,
      /no\s+(?:coincide|corresponde)\s+con/i,
    ],
  },
  {
    reason: 'late_delivery',
    condition: 'unknown',
    confidence: 0.7,
    patterns: [/\b(?:late|late\s+delivery|delayed|took\s+too\s+long|weeks?\s+late)\b/i, /en\s+retard|\btardif\b/i, /\btarde\b/i],
  },
  {
    reason: 'changed_mind',
    condition: 'unopened',
    confidence: 0.75,
    patterns: [/changed\s+my\s+mind/i, /no\s+longer\s+(?:need|want)/i, /don'?t\s+need\s+it\s+any\s?more/i, /\bregret\w*\b/i],
  },
];

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
const EXPLICIT_DIRECTIVE = /\b(?:approve|authorise|authorize|grant|pay|issue|process)\b/i;

const LANGUAGE_MARKERS: readonly { code: string; pattern: RegExp }[] = [
  { code: 'fr', pattern: /\b(?:bonjour|merci|colis|remboursement|administrateur|politique|commande|arriv[ée])\b/i },
  { code: 'es', pattern: /\b(?:hola|gracias|pedido|reembolso|env[ií]o|paquete)\b/i },
  { code: 'de', pattern: /\b(?:hallo|danke|bestellung|erstattung|lieferung)\b/i },
];

/** Words too generic to identify a product. */
const STOPWORDS = new Set(['set', 'pair', 'box', 'pack', 'and', 'the', 'for', 'with', 'size', 'kit']);
const MAX_EVIDENCE_LENGTH = 400;

/** Reasons the local extractor is willing to sign off on without a human. */
const AUTO_APPROVABLE: ReadonlySet<ClaimExtraction['reason']> = new Set([
  'damaged',
  'wrong_item',
  'not_as_described',
  'duplicate_charge',
]);

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

function analyzeWithHeuristics(input: AnalyzerInput, observer: AttemptObserver): AgentReply {
  observer({ model: MODEL, attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });
  if (isNoComplaint(input.message)) {
    return {
      kind: 'question',
      question: noComplaintQuestion(input.message, input.order !== null),
      model: MODEL,
    };
  }
  const extraction = read(input);
  return {
    kind: 'claim',
    extraction,
    proposal: {
      suggestedDecision: suggestDecision(extraction.reason, input.message, extraction.policyOverrideAttempted),
      suggestedAmountCents: extraction.claimedAmountCents ?? 0,
      confidence: extraction.confidence,
      reason: extraction.reason,
      model: MODEL,
    },
    model: MODEL,
  };
}

function read(input: AnalyzerInput): ClaimExtraction {
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
    claimedAmountCents: claimed ?? input.order?.totalCents ?? 0,
    items: mentionedItems(message, input.order?.items ?? []),
    evidenceQuotes: claim.quote === null ? [] : [claim.quote],
    language: detectLanguage(message),
    urgency: URGENT.test(message) ? 'high' : 'normal',
    policyOverrideAttempted: scanForInjection(message).detected,
  };
}

interface Reading {
  readonly reason: ClaimExtraction['reason'];
  readonly condition: ClaimExtraction['condition'];
  readonly confidence: number;
  /** Verbatim sentence supporting the reason, or null if nothing matched. */
  readonly quote: string | null;
}

function readClaim(message: string): Reading {
  for (const candidate of REASON_PATTERNS) {
    for (const pattern of candidate.patterns) {
      const match = pattern.exec(message);
      if (match !== null) {
        return { reason: candidate.reason, condition: candidate.condition, confidence: candidate.confidence, quote: sentenceFor(message, match) };
      }
    }
  }
  return { reason: 'other', condition: 'unknown', confidence: 0.35, quote: null };
}

/**
 * The sentence a match was found in, exactly as the customer wrote it.
 *
 * Copying the real sentence rather than the matched fragment is what keeps the
 * grounding guarantee honest: if this returned only the regex hit, a test could
 * pass a quote the customer never actually typed.
 */
function sentenceFor(message: string, match: RegExpMatchArray): string | null {
  const needle = match[0].trim();
  if (needle.length === 0) {
    return null;
  }
  const hit = splitSentences(message).find((sentence) => sentence.toLowerCase().includes(needle.toLowerCase()));
  return hit === undefined ? null : hit.slice(0, MAX_EVIDENCE_LENGTH);
}

function splitSentences(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

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
 * The local extractor's preference, recorded as data.
 *
 * It is optimistically pro-approval on damaged and wrong-item claims, and on
 * messages that both attempt an override and ask for money outright. That is
 * deliberate and it is not a weakness: a proposal the policy disagrees with is
 * the interesting case, because it exercises the clamp and shows up in the audit
 * trail. The disagreement is resolved by the resolver, and the resolver's answer
 * is what is stored, sent and paid.
 */
function suggestDecision(
  reason: ClaimExtraction['reason'],
  message: string,
  injectionDetected: boolean,
): 'approved' | 'escalated' {
  if (injectionDetected && EXPLICIT_DIRECTIVE.test(message)) {
    return 'approved';
  }
  return AUTO_APPROVABLE.has(reason) ? 'approved' : 'escalated';
}

export { AiUnavailableError };

/**
 * Chat mode for escalated conversations (local heuristic version).
 *
 * Provides a helpful, conversational response with no monetary authority.
 * Can use the remind_admin tool to notify the human agent.
 */
function chatWithHeuristics(input: ChatInput, observer: AttemptObserver): ChatReply {
  observer({ model: MODEL, attempt: 1, ok: true, latencyMs: 0, promptTokens: null, completionTokens: null, error: null });

  const message = input.message.toLowerCase();

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
