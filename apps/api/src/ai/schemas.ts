import { z } from 'zod';
import { DECISIONS, ClaimExtractionSchema } from '@refund/shared';

/**
 * Wire format for the model's single output.
 *
 * The model returns its reading of the message *and* what it would like to
 * happen. Both are treated as data: the resolver compares them against the
 * policy and records any disagreement, but neither field can change an outcome.
 * Having the model state a preference explicitly is what makes the clamp visible
 * in the admin drawer instead of hypothetical.
 */
export const ExtractionOutputSchema = ClaimExtractionSchema.extend({
  suggestedDecision: z.enum(DECISIONS),
  suggestedAmountCents: z.number().int().nonnegative(),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;


/** Compact schema description for the prompt. Not enforced by the provider. */
export function describeOutput(shape: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(shape), null, 2);
}
