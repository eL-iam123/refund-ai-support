import type { DialogueLine } from '../ai/analyzer.js';

/**
 * How the customer wants to be talked to, inferred from their own turns.
 *
 * Derived per request from the stored thread, never persisted: a profile in
 * the database would be a judgement about a person kept past the conversation
 * it served. Only repeated behaviour moves it - one message is a mood, three
 * alike are a preference.
 */
export interface ToneProfile {
  readonly tone: 'concise' | 'friendly' | 'detailed';
}

/** How many recent customer turns set the tone. Bounded so old threads cannot shout. */
const TONE_TURNS = 6;
/** Courtesy markers that make a thread friendly rather than terse. */
const WARM_WORDS: readonly RegExp[] = [/\bplease\b/i, /\bthanks?\b/i, /\bthank you\b/i, /\bhi\b/i, /\bhello\b/i, /!/];

/**
 * Reads the customer's last few turns and names the tone.
 *
 * Three buckets, each a different failure avoided: terse customers get short
 * answers instead of paragraphs they will not read; warm customers get
 * greeted rather than processed; customers who write in detail get the full
 * explanation instead of a sentence that sends them back to ask again.
 */
export function inferTone(history: readonly DialogueLine[]): ToneProfile {
  const said = history.filter((line) => line.role === 'customer').slice(-TONE_TURNS);
  if (said.length === 0) {
    return { tone: 'friendly' };
  }
  const text = said.map((line) => line.text).join('\n');
  const average = text.length / said.length;
  const warm = WARM_WORDS.some((pattern) => pattern.test(text));
  if (average <= 60 && !warm) {
    return { tone: 'concise' };
  }
  if (average > 160 && !warm) {
    return { tone: 'detailed' };
  }
  return { tone: 'friendly' };
}
