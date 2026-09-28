import type { ClaimExtraction } from '@refund/shared';
import {
  AiUnavailableError,
  type AIAnalyzer,
  type AnalyzerInput,
  type AnalyzerResult,
  type AttemptObserver,
} from '../ai/analyzer.js';
import { scanForInjection } from '../security/injection.js';

/**
 * The test double for a language model.
 *
 * This is the only reason a fake exists, and it lives here rather than in `src/`
 * so that no running server can reach it. A "mock mode" shipped as a product
 * feature would be a second, differently-tested decision path, and every bug
 * fixed in the real adapter would leave that path rotting.
 *
 * Three shapes, because tests need three things:
 *
 * - `heuristic()` reads the message with the same pattern matching a competent
 *   extractor would apply. The scenario suite needs this: eighteen different
 *   messages, each of which must produce the claim the policy is then judged
 *   on. Returns evidence as verbatim sentences, which is the invariant the
 *   grounding check exists to enforce, so a test cannot accidentally pass by
 *   feeding the policy a fabricated quote.
 * - `fixed(...)` returns a hand-written claim, for tests about one rule.
 * - `unavailable()` rejects, for the fail-soft path.
 */

const MODEL = 'fake-heuristic-v1';

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

/** Reasons the fake is willing to sign off on without a human. */
const AUTO_APPROVABLE: ReadonlySet<ClaimExtraction['reason']> = new Set([
  'damaged',
  'wrong_item',
  'not_as_described',
  'duplicate_charge',
]);

export function FakeAnalyzer(behaviour: Behaviour = { kind: 'heuristic' }): AIAnalyzer {
  switch (behaviour.kind) {
    case 'heuristic':
      return { label: 'fake (test)', model: MODEL, analyze: heuristicAnalyze };
    case 'fixed':
      return fixedAnalyzer(behaviour);
    case 'unavailable':
      return unavailableAnalyzer(behaviour.message);
  }
}

export type Behaviour =
  | { readonly kind: 'heuristic' }
  | { readonly kind: 'fixed'; readonly extraction: Partial<ClaimExtraction> }
  | { readonly kind: 'unavailable'; readonly message: string };

const BASE_EXTRACTION: ClaimExtraction = {
  intent: 'refund',
  reason: 'other',
  condition: 'unknown',
  confidence: 0.5,
  orderRef: null,
  claimedAmountCents: null,
  items: [],
  evidenceQuotes: [],
  language: 'en',
  urgency: 'normal',
  policyOverrideAttempted: false,
};

function fixedAnalyzer(behaviour: { readonly extraction: Partial<ClaimExtraction> }): AIAnalyzer {
  const extraction = { ...BASE_EXTRACTION, ...behaviour.extraction };
  return {
    label: 'fake (test)',
    model: 'fake-fixed-v1',
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult> {
      recordOk(observer, 'fake-fixed-v1');
      return Promise.resolve({
        extraction,
        proposal: {
          suggestedDecision: 'approved',
          suggestedAmountCents: extraction.claimedAmountCents ?? 0,
          confidence: extraction.confidence,
          reason: extraction.reason,
          model: 'fake-fixed-v1',
        },
        model: 'fake-fixed-v1',
      });
    },
  };
}

function unavailableAnalyzer(message: string): AIAnalyzer {
  return {
    label: 'fake (test)',
    model: 'fake-unavailable-v1',
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult> {
      recordOk(observer, 'fake-unavailable-v1');
      return Promise.reject(new AiUnavailableError(message));
    },
  };
}


function recordOk(observer: AttemptObserver, model: string): void {
  observer({
    model,
    attempt: 1,
    ok: true,
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    error: null,
  });
}

function heuristicAnalyze(input: AnalyzerInput, observer: AttemptObserver): Promise<AnalyzerResult> {
  recordOk(observer, MODEL);
  const extraction = read(input);
  const amount = extraction.claimedAmountCents ?? 0;
  return Promise.resolve({
    extraction,
    proposal: {
      suggestedDecision: suggestDecision(extraction.reason, input.message, extraction.policyOverrideAttempted),
      suggestedAmountCents: amount,
      confidence: extraction.confidence,
      reason: extraction.reason,
      model: MODEL,
    },
    model: MODEL,
  });
}

function read(input: AnalyzerInput): ClaimExtraction {
  const message = input.message;
  const claim = readClaim(message);
  const claimed = claimedAmountCents(message);
  const orderTotal = input.order?.totalCents ?? 0;

  return {
    intent: detectIntent(message),
    reason: claim.reason,
    condition: claim.condition,
    confidence: claim.confidence,
    orderRef: ORDER_REFERENCE.exec(message)?.[0] ?? null,
    // A customer asking for "the whole order" has named an amount: the total.
    claimedAmountCents: claimed ?? orderTotal,
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
        return {
          reason: candidate.reason,
          condition: candidate.condition,
          confidence: candidate.confidence,
          quote: sentenceFor(message, match),
        };
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
  const hit = splitSentences(message).find((sentence) =>
    sentence.toLowerCase().includes(needle.toLowerCase()),
  );
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
      item.name
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .some((word) => word.length >= 4 && !STOPWORDS.has(word) && haystack.includes(word)),
    )
    .map((item) => item.id);
}

/** The fake's preference. Prompted messages get an approval, which is the point. */
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
