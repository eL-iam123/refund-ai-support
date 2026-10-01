/**
 * Ask for actionable condition details before a sparse physical-damage claim
 * reaches reason rules. The policy engine remains authoritative; this only
 * prevents a one-word condition such as "damaged" from being mistaken for a
 * useful account of what happened.
 */

const DAMAGE_REPORT = /\b(?:damaged|damage|faulty|defective)\b/i;
const SPECIFIC_DAMAGE =
  /\b(?:crack(?:ed|s)?|break(?:s|ing)?|broken|chip(?:ped|s)?|shatter(?:ed|s)?|dent(?:ed|s)?|scratch(?:ed|es)?|tear(?:s|ing)?|torn|split|leak(?:s|ing)?|bent|crush(?:ed)?|hole|puncture|burn(?:ed|t)?|stain(?:ed)?|loose|missing\s+(?:a\s+)?(?:part|piece|handle|lid))\b/i;

/**
 * Return one focused question when a customer reports damage without saying
 * what the damage is. Specific descriptions such as "the handle is cracked"
 * continue normally to grounding and the deterministic policy engine.
 */
export function clarifySparseDamage(message: string): string | null {
  const wordCount = message.trim().split(/\s+/u).length;
  if (wordCount > 6 || !DAMAGE_REPORT.test(message) || SPECIFIC_DAMAGE.test(message)) {
    return null;
  }
  return "I'm sorry the item is damaged. Could you describe exactly what the damage looks like?";
}
