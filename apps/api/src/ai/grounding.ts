import type { ClaimExtraction, GroundingResult, LineGrounding } from '@refund/shared';
import { MIN_EVIDENCE_QUOTE_LENGTH, MIN_GROUNDED_QUOTES } from '../policy/constants.js';

/**
 * Grounding check (REFUND_POLICY.md §8).
 *
 * A model is perfectly willing to assert `reason: "damaged"` about a customer
 * who never mentioned damage. So every quote the model offers as evidence must
 * be found in the customer's own words. A claim with no verified quote cannot
 * approve anything - at worst it escalates.
 *
 * The corpus is everything the customer has actually written - the current
 * message plus their earlier messages on the same order, because the model is
 * now allowed to quote an earlier turn ("you said it arrived cracked"). The
 * one thing a quote can never come from is the assistant's own words, which is
 * why the corpus is built from the customer side of the transcript alone and
 * why a sentence the assistant wrote can never launder itself into evidence.
 *
 * "Verbatim" is operationalised as: same characters, ignoring letter case and
 * runs of whitespace, within a single customer message. Anything looser would
 * let a paraphrased quote pass as evidence, and joining the messages together
 * would let a quote span two messages, which no customer ever wrote as one.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function verifyQuote(corpus: readonly string[], quote: string): boolean {
  if (quote.trim().length < MIN_EVIDENCE_QUOTE_LENGTH) {
    return false;
  }
  const wanted = normalise(quote);
  return corpus.some((message) => normalise(message).includes(wanted));
}

export function verifyGrounding(
  extraction: ClaimExtraction | null,
  corpus: readonly string[],
): GroundingResult | null {
  if (extraction === null) {
    return null;
  }

  const verified: string[] = [];
  const rejected: string[] = [];

  for (const quote of extraction.evidenceQuotes) {
    if (verifyQuote(corpus, quote)) {
      verified.push(quote);
    } else {
      rejected.push(quote);
    }
  }

  return {
    grounded: verified.length >= MIN_GROUNDED_QUOTES,
    verifiedQuotes: verified,
    rejectedQuotes: rejected,
    ...lineExtras(verifyLineClaims(extraction, corpus)),
  };
}

/**
 * Attaches the per-line result only when there is one.
 *
 * With `exactOptionalPropertyTypes`, an absent field is not the same as a field
 * set to `undefined`, and `lines` absent is exactly how the reason rules tell
 * "no per-line reading" from "every line failed".
 */
function lineExtras(lines: readonly LineGrounding[]): { lines: readonly LineGrounding[] } | Record<string, never> {
  return lines.length === 0 ? {} : { lines };
}

/**
 * The same verification, per claimed line.
 *
 * `lineClaims` is what lets a mixed basket be paid line by line - "the mug
 * arrived broken and the lamp shade is cracked" grounds the mug and not the
 * lamp only if the two reasons are checked apart, which is what a per-line
 * quote list exists for. A line with no verified quote is an escalation, not an
 * exclusion: its claim is merely unsupported, and a person still reads it.
 *
 * Returns an empty array when the extraction carried no `lineClaims`, which the
 * caller leaves off the result - `lines` absent is how a consumer tells "no
 * per-line data at all" from "every line's quotes were rejected": the first
 * falls back to the whole-message reading, the second must not.
 */
function verifyLineClaims(
  extraction: ClaimExtraction,
  corpus: readonly string[],
): readonly LineGrounding[] {
  const claims = extraction.lineClaims;
  if (claims === undefined || claims.length === 0) {
    return [];
  }
  return claims.map((claim) => {
    const line = verifyQuotes(claim.evidenceQuotes, corpus);
    return {
      itemId: claim.itemId,
      grounded: line.verified.length >= MIN_GROUNDED_QUOTES,
      verifiedQuotes: line.verified,
      rejectedQuotes: line.rejected,
    };
  });
}

function verifyQuotes(
  quotes: readonly string[],
  corpus: readonly string[],
): { verified: string[]; rejected: string[] } {
  const verified: string[] = [];
  const rejected: string[] = [];
  for (const quote of quotes) {
    if (verifyQuote(corpus, quote)) {
      verified.push(quote);
    } else {
      rejected.push(quote);
    }
  }
  return { verified, rejected };
}