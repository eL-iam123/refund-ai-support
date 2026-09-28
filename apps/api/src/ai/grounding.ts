import type { ClaimExtraction, GroundingResult } from '@refund/shared';
import { MIN_EVIDENCE_QUOTE_LENGTH, MIN_GROUNDED_QUOTES } from '../policy/constants.js';

/**
 * Grounding check (REFUND_POLICY.md §8).
 *
 * A model is perfectly willing to assert `reason: "damaged"` about a customer
 * who never mentioned damage. So every quote the model offers as evidence must
 * be found in the customer's own message. A claim with no verified quote cannot
 * approve anything - at worst it escalates.
 *
 * "Verbatim" is operationalised as: same characters, ignoring letter case and
 * runs of whitespace. Anything looser would let a paraphrased quote pass as
 * evidence.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function verifyQuote(haystack: string, quote: string): boolean {
  if (quote.trim().length < MIN_EVIDENCE_QUOTE_LENGTH) {
    return false;
  }
  return haystack.includes(normalise(quote));
}

export function verifyGrounding(
  extraction: ClaimExtraction | null,
  message: string,
): GroundingResult | null {
  if (extraction === null) {
    return null;
  }

  const haystack = normalise(message);
  const verified: string[] = [];
  const rejected: string[] = [];

  for (const quote of extraction.evidenceQuotes) {
    if (verifyQuote(haystack, quote)) {
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
