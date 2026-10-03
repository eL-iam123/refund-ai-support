import type { ClaimExtraction } from '@refund/shared';

/**
 * What a message says happened, in one place.
 *
 * This table used to live inside the local analyzer, which made it unreachable from
 * the clarification questions: they had to know "has the customer already told us
 * what went wrong?" and there was no way to ask without copying the pattern set - and a
 * copied pattern set is a set that quietly stops matching the thing it was written
 * for. One table, two readers: the matcher that builds a claim and the questioner
 * that decides what to ask next.
 *
 * Order matters and is the point: `duplicate_charge` is checked before `damaged`
 * because "I was charged twice for the mug" is a duplicate charge, not a damaged mug.
 * First match wins.
 */

export interface ReasonPattern {
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

export interface Reading {
  readonly reason: ClaimExtraction['reason'];
  readonly condition: ClaimExtraction['condition'];
  readonly confidence: number;
  /** Verbatim sentence supporting the reason, or null if nothing matched. */
  readonly quote: string | null;
}

/** A ceiling on an evidence quote: long enough to be a sentence, short enough to read. */
const MAX_EVIDENCE_LENGTH = 240;

/** Reads a message the way the matcher does, or reports that it said nothing. */
export function readClaim(message: string): Reading {
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
 * The customer's own sentence that supports the reading.
 *
 * The *sentence*, not the matched fragment: grounding checks quotes against the
 * transcript, and a two-word fragment reads as a quote nobody made.
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

/**
 * Whether the customer has already said what went wrong.
 *
 * `other` and `none` mean the table did not recognise it, which is not the same as
 * "they told us nothing" - a complaint about a smell, a fee or a delay the table does
 * not cover would read as silence here. Deliberately optimistic, because the cost of
 * being wrong is asymmetric: assuming too much and staying quiet strands a customer,
 * while assuming too little asks one question they can answer.
 */
export function hasReadableReason(message: string): boolean {
  return detectedReason(message) !== null;
}

/**
 * The reason the table recognises, or null when it recognises none.
 *
 * Null rather than `'other'`, so "they told us it was a duplicate charge" and "we
 * could not tell what they meant" are distinguishable by callers instead of both
 * arriving as the same string.
 */
export function detectedReason(message: string): ClaimExtraction['reason'] | null {
  const reading = readClaim(message);
  return reading.reason === 'other' || reading.reason === 'none' ? null : reading.reason;
}

/** The condition the message implies, when it implies one. */
export function readableCondition(message: string): ClaimExtraction['condition'] {
  return readClaim(message).condition;
}
