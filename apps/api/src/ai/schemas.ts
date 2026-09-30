import { z } from 'zod';
import { DECISIONS, ClaimExtractionSchema } from '@refund/shared';

/**
 * Wire format for the model's single output.
 *
 * The model is a messenger with exactly two tools, and both are represented
 * here so the discriminator is mechanical rather than prompt-shaped.
 *
 *  - `ask`: the messenger half. The model asks the customer one question, the
 *    missing detail that keeps it from being able to submit a claim. That
 *    question becomes the customer-facing reply, verbatim - which is why it is
 *    the only prose the model is ever allowed to produce, and why it is bounded
 *    and stored separately from any decision.
 *  - `decide`: the engine half. The model returns its reading of the message
 *    *and* what it would like to happen. Both are treated as data: the resolver
 *    compares them against the policy and records any disagreement, but neither
 *    field can change an outcome. Having the model state a preference
 *    explicitly is what makes the clamp visible in the admin drawer instead of
 *    hypothetical.
 *
 * A claim is never composed by the model. Whether the model asks or decides,
 * the words the customer reads come from the question it asked or from the
 * deterministic compose step - never from a model-written decision paragraph.
 */

export const AskSchema = z.object({
  action: z.literal('ask'),
  question: z.string().min(1).max(400),
});

export const ExtractionOutputSchema = ClaimExtractionSchema.extend({
  suggestedDecision: z.enum(DECISIONS),
  suggestedAmountCents: z.number().int().nonnegative(),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const DecideSchema = ExtractionOutputSchema.extend({
  action: z.literal('decide'),
});
export type DecideOutput = z.infer<typeof DecideSchema>;

export const AgentOutputSchema = z.union([AskSchema, DecideSchema]);
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/** Compact schema description for the prompt. Not enforced by the provider. */
export function describeOutput(shape: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(shape), null, 2);
}