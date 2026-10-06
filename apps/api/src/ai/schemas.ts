import { z } from 'zod';
import { ClaimExtractionSchema } from '@refund/shared';

/**
 * Wire format for the model's one output.
 *
 * Two shapes, and the discriminator is mechanical rather than prompt-shaped:
 *
 *  - `ask` is the messenger half. The model asks the customer one question, the
 *    missing detail that keeps it from being able to submit a claim. That
 *    question becomes the customer-facing reply, verbatim - which is why it is
 *    the only prose the model is ever allowed to produce, and why it is bounded
 *    and stored separately from any decision.
 *  - `decide` is the engine half, and it is a *reading*: the reason the customer
 *    gave, in their own words, with quotes. There is no decision field and no
 *    amount field, so there is nothing in this schema that could be mistaken
 *    for an outcome. Zod strips undeclared keys, which means a reasoning model
 *    returning a chain of thought, or an injected one returning whatever it
 *    likes, cannot smuggle a field past the resolver.
 *
 * A claim is never composed by the model. Whether the model asks or decides,
 * the words the customer reads come from the question it asked or from the
 * deterministic compose step - never from a model-written decision paragraph.
 */

export const AskSchema = z.object({
  action: z.literal('ask'),
  question: z.string().min(1).max(400),
});

/**
 * The complete claim, flat alongside the discriminator.
 *
 * Flat rather than nested under `extraction` because this is the tool-call
 * argument shape as well: Anthropic delivers a tool's input as an object, and
 * reading it back off the call is the whole of the adapter's job.
 */
export const CompleteSchema = ClaimExtractionSchema.extend({
  action: z.literal('decide'),
});
export type CompleteOutput = z.infer<typeof CompleteSchema>;

/** The most lines one offer can name. Bounded so the array cannot be a payload. */
export const MAX_ITEM_CANDIDATES = 8;

/**
 * The model's request for the item picker.
 *
 * Deliberately carries no free text. `ask_question` may put model prose in front
 * of a customer because that prose *is* the answer to a question; here the answer
 * is a list of buttons, so a caption would be a second, worse interface. Empty
 * `candidates` means "I could not tell them apart" and is not an error - the
 * server offers the lines anyway.
 *
 * `candidates` is a *hint*, and the name is the point: they are re-checked
 * against the resolved order in `retrieval/itemPicker.ts`, and no part of the
 * scope that reaches the money ever comes from this array. What the customer
 * clicks does.
 */
export const AskItemsSchema = z.object({
  action: z.literal('ask_items'),
  candidates: z.array(z.string().min(1).max(64)).max(MAX_ITEM_CANDIDATES).default([]),
});

export const IntakeOutputSchema = z.union([AskItemsSchema, AskSchema, CompleteSchema]);
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

/** The most product cards one shop answer may carry. Bounded so the array cannot be a payload. */
export const MAX_SHOP_PRODUCTS = 5;

/**
 * The model's product nomination.
 *
 * Ids only, copied from the catalogue block in the prompt. There is no price
 * and no prose field, so there is nothing in this schema that could be
 * mistaken for an offer: what the customer sees is rendered deterministically
 * from database rows re-resolved by id.
 */
export const ShopSuggestionSchema = z.object({
  productIds: z.array(z.string().min(1).max(64)).max(MAX_SHOP_PRODUCTS).default([]),
});
export type ShopSuggestionOutput = z.infer<typeof ShopSuggestionSchema>;

/** The longest a conversational reply may be. Bounded so verbosity is a choice, not a bill. */
export const MAX_GENERAL_CHARS = 600;

/** A conversational reply, bounded. Content rules live in `replyGuard.ts`. */
export const GeneralReplySchema = z.string().trim().min(1).max(MAX_GENERAL_CHARS);
export type GeneralReplyOutput = z.infer<typeof GeneralReplySchema>;

/**
 * A phrased decision reply, bounded like any other prose.
 *
 * Length is the schema's whole job: what the reply may *say* is the
 * validator's (`isSafePhrasedReply`), because allowlists over an envelope
 * cannot be expressed as a shape.
 */
export const PhraseReplySchema = z.string().trim().min(1).max(MAX_GENERAL_CHARS);
export type PhraseReplyOutput = z.infer<typeof PhraseReplySchema>;

/** Compact schema description for the prompt. Not enforced by the provider. */
export function describeOutput(shape: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(shape), null, 2);
}

/**
 * A case summary, bounded.
 *
 * A paragraph an agent skims, so the ceiling is low and the floor is a sentence. The
 * empty string is not a valid summary: there is a documented phrase for "nothing to
 * add", and a blank cell in a case file reads as a bug rather than as an absence.
 */
export const CaseSummarySchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(800));
