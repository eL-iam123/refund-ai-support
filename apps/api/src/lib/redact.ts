/**
 * Removes credential-shaped strings from text that is about to be persisted or
 * shown in the admin drawer.
 *
 * Provider error bodies are the one place a secret can leak into our own
 * database: an SDK error may quote the request it failed to send. The message
 * is useful for debugging and useless if it carries a live key, so it is
 * filtered on the way out rather than trusted on the way in.
 */

/** Deliberately shapes, not a known-key list: the value is what must not survive. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // `sk-...`, including OpenRouter's `sk-or-v1-...`.
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  // NVIDIA's `nvapi-...`, which shares no prefix with the others.
  /\bnvapi-[A-Za-z0-9_-]{6,}/g,
  // `Authorization: Bearer <token>`.
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  // `"apiKey": "..."` in a JSON error body, whatever the field is called.
  /("?(?:api[_-]?key|authorization|access[_-]?token|secret)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
];

const PLACEHOLDER = '[redacted]';

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match: string, prefix: string | undefined) =>
      prefix === undefined ? PLACEHOLDER : `${prefix}${PLACEHOLDER}`,
    );
  }
  return out;
}
