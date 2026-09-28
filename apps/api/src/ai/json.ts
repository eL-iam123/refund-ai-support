/**
 * Models wrap JSON in all sorts of ways. Tries the whole string, then a fenced
 * block, then the outermost brace span - bounded, and it never guesses content.
 */

/**
 * A cap for a provider that ignores `max_tokens`.
 *
 * Truncation can only ever cost a valid parse - never produce a wrong one - and
 * the alternative is letting a misbehaving endpoint dictate how much memory and
 * CPU one customer request spends.
 */
const MAX_INPUT_LENGTH = 64_000;

export function parseJson(text: string): unknown {
  const trimmed = text.trim().slice(0, MAX_INPUT_LENGTH);
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    candidates.push(fenced[1].trim());
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}
