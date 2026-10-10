import type { InjectionCategory, InjectionScan, InjectionSignal } from '@refund/shared';

/**
 * Policy-override detection.
 *
 * Scope, stated plainly: this matches four specific categories in English, and
 * nothing else. It is a high-precision filter for the attack this system is
 * actually built to withstand, not a general prompt-injection detector. It will
 * miss obfuscated, translated, or novel phrasings - scenario S-18 exists to
 * prove that it does.
 *
 * The reason a miss is survivable: a request that gets past this scanner still
 * cannot move money, because eligibility, amount and decision are all owned by
 * the policy engine (see docs/adr/0002-injection-scope-and-limits.md).
 */

interface Rule {
  readonly id: string;
  readonly category: InjectionCategory;
  readonly pattern: RegExp;
}

/** §7.1 - attempts to ignore, replace or bypass the governing policy. */
const POLICY_OVERRIDE: readonly Rule[] = [
  {
    id: 'ignore-policy',
    category: 'policy_override',
    pattern:
      /\b(ignore|disregard|forget|bypass|override|skip)\b[^.!?]{0,50}\b(polic\w*|rules?|terms|conditions|instructions?|guidelines?|restrictions?|requirements?)\b/i,
  },
  { id: 'address-the-prompt', category: 'policy_override', pattern: /\byour\s+(prompt|system\s+prompt|instructions?|programming|directives?)\b/i },
  { id: 'new-instructions', category: 'policy_override', pattern: /\bnew\s+(instructions?|rules?|directives?)\b/i },
  { id: 'disregard-everything', category: 'policy_override', pattern: /\bdisregard\s+(all|everything|any)\b/i },
  { id: 'from-now-on', category: 'policy_override', pattern: /\bfor\s+(everything|all)\s+(from\s+now\s+on|onwards?)\b/i },
  { id: 'pretend-no-rules', category: 'policy_override', pattern: /\bpretend\s+(you\s+(have|had)\s+no|there\s+(is|are)\s+no)\b/i },
];

/** §7.1 - attempts to dictate the outcome regardless of the facts. */
const DECISION_MANIPULATION: readonly Rule[] = [
  {
    id: 'approve-unconditional',
    category: 'decision_manipulation',
    pattern:
      /\b(approve|authorise|authorize|grant|issue|process)\b[^.!?]{0,40}\b(no\s+matter|regardless|without\s+(checking|question|review|approval)|automatically|unconditionally|whatever)\b/i,
  },
  {
    id: 'must-approve',
    category: 'decision_manipulation',
    pattern: /\byou\s+(must|have\s+to|are\s+required\s+to|need\s+to|shall)\b[^.!?]{0,30}\b(approve|authorise|authorize|grant|issue|process)\b/i,
  },
  { id: 'always-approve', category: 'decision_manipulation', pattern: /\b(always|automatically|auto)[\s-]?(approve|authorise|authorize)\b/i },
  { id: 'force-positive', category: 'decision_manipulation', pattern: /\bmake\s+(the|this)\s+(decision|verdict|outcome)\s+(positive|approved)\b/i },
  { id: 'guarantee-approval', category: 'decision_manipulation', pattern: /\b(guarantee|guaranteed)\s+(approval|refund)\b/i },
];

/** §7.1 - claiming to be staff, the system, or the developer. */
const ROLE_IMPERSONATION: readonly Rule[] = [
  {
    id: 'you-are-now-staff',
    category: 'role_impersonation',
    pattern:
      /\byou\s+are\s+(now\s+)?(an?|the)\s+(admin|administrator|manager|supervisor|owner|agent|system|bot|ai|assistant|developer|operator)\b/i,
  },
  {
    id: 'act-as-staff',
    category: 'role_impersonation',
    pattern: /\b(act|behave|respond|pretend)\s+(as|like)\b[^.!?]{0,30}\b(admin|administrator|system|developer|support\s+agent|owner)\b/i,
  },
  {
    id: 'i-am-staff',
    category: 'role_impersonation',
    pattern: /\b(this\s+is|i\s+am|i'm)\s+(the\s+)?(system|developer|admin|administrator|owner|store\s+owner|support)\b/i,
  },
  { id: 'developer-mode', category: 'role_impersonation', pattern: /\b(developer|god|debug|admin)\s+mode\b/i },
  { id: 'system-override', category: 'role_impersonation', pattern: /\bsystem\s+(override|prompt|message|notice)\b/i },
  { id: 'sudo', category: 'role_impersonation', pattern: /\bsudo\b/i },
];

const RULES: readonly Rule[] = [
  ...POLICY_OVERRIDE,
  ...DECISION_MANIPULATION,
  ...ROLE_IMPERSONATION,
];

/** An explicit money figure being demanded. */
const AMOUNT_DEMAND =
  /\b(approve|authorise|authorize|refund|reimburse|issue|pay|credit)\b[^.!?]{0,40}\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars|usd|\b)/i;

/** Non-decision-affecting oddities, recorded for the audit trail only. */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{24,}={0,2}\b/;

/** Strips invisible characters so "ig\u200bnore" cannot slip past a pattern. */
function normalise(message: string): string {
  return message
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function noteObfuscation(message: string): boolean {
  return ZERO_WIDTH.test(message) || BASE64_BLOB.test(message);
}

/**
 * `amount_manipulation` needs two signals, not one: a demanded figure on its
 * own is just a customer asking for money, which is what the refund channel is
 * for. It only counts as an override attempt when it arrives alongside a
 * policy, authority or decision-manipulation demand. Without this two-signal
 * rule, scenario S-06 ("refund my $450 order") would be denied as an attack
 * instead of escalated for review.
 */
function amountSignal(text: string, otherCategories: ReadonlySet<InjectionCategory>): InjectionSignal | null {
  if (otherCategories.size === 0 || !AMOUNT_DEMAND.test(text)) {
    return null;
  }
  return {
    category: 'amount_manipulation',
    pattern: 'amount-demand-with-override-signal',
    matchedText: AMOUNT_DEMAND.exec(text)?.[0].trim() ?? '',
  };
}

export function scanForInjection(message: string): InjectionScan {
  const text = normalise(message);
  const signals: InjectionSignal[] = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match !== null) {
      signals.push({ category: rule.category, pattern: rule.id, matchedText: match[0].trim() });
    }
  }

  const categories = new Set(signals.map((signal) => signal.category));
  const amount = amountSignal(text, categories);
  if (amount !== null) {
    signals.push(amount);
    categories.add('amount_manipulation');
  }

  return {
    detected: signals.length > 0,
    signals,
    obfuscationNoted: noteObfuscation(message),
  };
}
