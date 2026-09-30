import type { ClaimExtraction, GroundingResult } from '@refund/shared';
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
  };
}