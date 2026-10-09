/**
 * Renders REFUND_POLICY.md from the live rule objects.
 *
 * The document is not written by hand. Every section number, rule title, class,
 * stage, allowed-outcome set and threshold is read from the code that enforces
 * it, so the published policy and the enforced policy cannot drift apart: if a
 * rule changes, `renderPolicyDocument()` changes, and policyDocument.test.ts
 * fails until the file on disk is regenerated.
 *
 * Only the clause prose below is authored here. The numbers never are.
 */

import { ALLOWED_OUTCOMES, PRECEDENCE } from '@refund/shared';
import { formatCents } from '../lib/money.js';
import {
  ESCALATION_CEILING_CENTS,
  EXTENDED_WINDOW_DAYS,
  FULLY_REFUNDED,
  HUMAN_REVIEW_THRESHOLD_CENTS,
  MIN_EVIDENCE_QUOTE_LENGTH,
  MIN_GROUNDED_QUOTES,
  RISK_NEW_ACCOUNT_DAYS,
  RISK_PRIOR_REFUNDS,
  RISK_RECENT_REQUESTS,
  RISK_SIGNAL_THRESHOLD,
  STANDARD_WINDOW_DAYS,
} from './constants.js';
import { POLICY_RULES } from './rules/index.js';
import type { PolicyRule } from './types.js';

interface SectionSpec {
  /** `2.1` for a numbered clause, or `1` for a top-level chapter. */
  readonly number: string;
  readonly title: string;
  /** The clause text. May interpolate constants via the helpers below. */
  readonly body: readonly string[];
  /** Present exactly when a rule enforces this section. */
  readonly ruleId?: string;
}

const money = (cents: number): string => formatCents(cents);

const STANDARD_WINDOW_CLAUSE = `A refund is **standard** if the request is made within ${STANDARD_WINDOW_DAYS} days of delivery, counted from the delivered timestamp and not from the order date.`;

const ABSOLUTE_WINDOW_CLAUSE = `${EXTENDED_WINDOW_DAYS} days after delivery is the **absolute outer limit**. Nothing is refundable past it, whatever the reason given. There is no exception, no goodwill path and no agent override at this stage.`;

const SECTIONS: readonly SectionSpec[] = [
  {
    number: '1',
    title: 'Scope and definitions',
    body: [
      'This policy governs automated refund decisions for delivered orders. It is enforced in code by the ordered rule list in `apps/api/src/policy/rules/`, and every decision the API returns carries the `policyRef` of the clause that produced it.',
      '**Definitions.** *Eligible item*: an order item that has passed every item-scope eligibility clause. *Eligible amount*: the sum of eligible item prices, in integer cents, never the amount the customer asked for and never the amount a model proposed. *Grounded claim*: an extracted reason supported by at least one quote verified as a verbatim substring of the customer\'s own message. *Decision*: one of `approved`, `denied`, `escalated`, `partial_refund`, `exchange`, `store_credit`. The first three are produced by the rules; the alternatives only by the discretion layer (§10).',
      '**What this policy is not.** It is not a description of what the language model does. The model reads the message and proposes; it never decides. See §9.',
    ],
  },
  {
    number: '2',
    title: 'Eligibility',
    body: [
      'These clauses establish whether the order or the item is refundable at all. They run before any reason is considered, and a denial here is final.',
      'Item-scope clauses adjust the eligible set rather than terminating the request on their own, so a blocked item reduces the refund instead of cancelling it.',
    ],
  },
  {
    number: '2.1',
    title: 'Final sale items',
    body: [
      'An item marked `finalSale` is not refundable for any reason, including damage. It is excluded from the eligible set, which reduces the refundable amount but leaves the rest of the order refundable.',
    ],
    ruleId: 'R-02',
  },
  {
    number: '2.2',
    title: 'Digital goods already downloaded',
    body: [
      'A digital item that has been downloaded cannot be refunded. A digital item that has not been downloaded is treated as an ordinary physical item.',
    ],
    ruleId: 'R-05',
  },
  {
    number: '2.3',
    title: 'Payment already settled or refunded',
    body: [
      `An order whose payment state is \`${FULLY_REFUNDED}\` and whose refunded amount already covers the order total cannot be refunded again. An order whose payment is still \`pending\` cannot be refunded, because there is no settled funds to return.`,
    ],
    ruleId: 'R-06',
  },
  {
    number: '2.4',
    title: 'Subscription and renewal charges',
    body: [
      'A subscription or automatic renewal charge is not refundable through this flow. It requires a billing specialist, because reversing a renewal re-grants service the customer may still be using.',
    ],
    ruleId: 'R-10',
  },
  {
    number: '2.5',
    title: 'No refundable balance remaining',
    body: [
      'An order cannot be refunded beyond what the customer paid. The refundable balance is the order total less everything already settled against the order, less every approval that is still waiting for a person to verify it.',
      'Counting approvals awaiting verification as spent is deliberate. It can refuse a claim the business would have honoured, and the remedy for that is a reviewer settling the queue. The alternative, treating an unverified approval as though it were free to issue again, lets one order be promised several times over while the first promise sits unread - and every one of those promises becomes money the business does not have.',
      'Because approval reserves money rather than moving it, a claim that was approved and later denied has its reservation released, and the balance returns to what it was.',
    ],
    ruleId: 'R-06b',
  },
  {
    number: '3',
    title: 'Refund windows',
    body: [
      'Windows are measured in days from the delivered timestamp. An order with no delivery timestamp cannot pass either window clause.',
    ],
  },
  { number: '3.1', title: 'Standard refund window', body: [STANDARD_WINDOW_CLAUSE], ruleId: 'R-01b' },
  { number: '3.2', title: 'Absolute refund window', body: [ABSOLUTE_WINDOW_CLAUSE], ruleId: 'R-01' },
  {
    number: '4',
    title: 'Approval authority',
    body: [
      'These clauses bound what the automated flow may approve on its own. They cannot approve, only escalate or pass, so a request that clears every other clause still lands with a human if the amount is large enough.',
    ],
  },
  {
    number: '4.1',
    title: 'Human review above threshold',
    body: [
      `A refund of more than ${money(HUMAN_REVIEW_THRESHOLD_CENTS)} requires human review. The amount is what the request actually puts at risk: the sum of the items the customer named, or the **order total** when they named none. It is measured before item-level denials are applied, so a request cannot dodge the threshold by excluding the very items it asks to refund, and a whole-order request cannot slip under it either.`,
    ],
    ruleId: 'R-03',
  },
  {
    number: '4.2',
    title: 'Eligible remainder after item-level denials',
    body: [
      'When item-level clauses (§2.1, §2.2, §2.4) reduce the eligible amount below the order total, the reduction is recorded explicitly in the audit trail.',
      'The §4.1 review threshold is evaluated against the claimed amount - the sum of the items the customer named, or the order total when they name none - before those denials are applied, so it is not affected by them. This clause never decides anything. It exists so the eligible remainder is legible to an auditor instead of looking accidental.',
    ],
    ruleId: 'R-03b',
  },
  {
    number: '5',
    title: 'Reason rules',
    body: [
      'These clauses decide whether a *reasoned* refund is warranted. They require a grounded claim: the reason must be quoted from the customer, not inferred. An ungrounded or absent reason can never approve.',
    ],
  },
  {
    number: '5.1',
    title: 'Damaged or incorrect goods',
    body: [
      'A refund is approved when the customer\'s own words describe goods that arrived damaged, faulty, or not as described, and the order is otherwise eligible. The model may only classify which of these reasons applies; it cannot create the claim.',
    ],
    ruleId: 'R-04',
  },
  {
    number: '5.2',
    title: 'Duplicate charge',
    body: [
      'Where a same-day, same-value sibling order exists for the customer, one of the two charges is a duplicate. The request is approved for the duplicate only, and only when the sibling order is identified rather than assumed.',
    ],
    ruleId: 'R-11',
  },
  {
    number: '5.3',
    title: 'No grounded reason in the request',
    body: [
      `A request that reaches the reason stage without a grounded reason escalates. It does not deny: the customer may have a legitimate reason they did not write down, and a human can read the order. A claim needs at least ${MIN_GROUNDED_QUOTES} verified quote${MIN_GROUNDED_QUOTES === 1 ? '' : 's'} to be considered at all (§8).`,
    ],
    ruleId: 'R-12',
  },
  {
    number: '6',
    title: 'Risk signals',
    body: [
      'Risk clauses escalate to a human. They never deny. A signal is a reason to look closer, not proof of wrongdoing, and refusing on a signal alone would punish a customer for something the policy has not established.',
    ],
  },
  {
    number: '6.1',
    title: 'Open chargeback on the order',
    body: ['An order with an open chargeback is already in dispute. Refunding it as well would pay twice, so the request escalates.'],
    ruleId: 'R-07',
  },
  {
    number: '6.2',
    title: 'Refund abuse signals',
    body: [
      `Three independent signals are counted: an account younger than ${RISK_NEW_ACCOUNT_DAYS} days, at least ${RISK_PRIOR_REFUNDS} prior refunds on record, and at least ${RISK_RECENT_REQUESTS} refund requests in the last 30 days.`,
      `At least ${RISK_SIGNAL_THRESHOLD} independent signals are required to escalate. A single signal is recorded and passed, because a burst of refunds can be a genuine run of bad luck.`,
    ],
    ruleId: 'R-08',
  },
  {
    number: '6.3',
    title: 'Conflicting customer and fulfilment evidence',
    body: [
      'Where the customer reports goods as damaged but fulfilment evidence records them as delivered intact and signed for, the two accounts conflict. Neither is disproved by the other, so the request escalates for a human to weigh.',
    ],
    ruleId: 'R-09',
  },
  {
    number: '6.4',
    title: 'Order reference cannot be resolved',
    body: [
      'A request naming an order that does not exist, or that belongs to a different customer, escalates. It is not denied: a mistyped or mistated reference is not an attempt to defraud, and a human can find the right order.',
    ],
    ruleId: 'R-13',
  },
  {
    number: '6.5',
    title: 'Amount at risk above manual-review ceiling',
    body: [
      `When the amount a request puts at risk exceeds the configured ceiling (default ${formatCents(ESCALATION_CEILING_CENTS)}), it is escalated to a person before the model is called. The amount is the sum of the items the customer named, or the order total when they named none; both are computable from the order facts alone, so this check still terminates before the model.`,
    ],
    ruleId: 'R-15',
  },
  {
    number: '7',
    title: 'Request integrity',
    body: ['The request channel is untrusted. These clauses treat the message as data to be parsed, never as instructions to be followed.'],
  },
  {
    number: '7.1',
    title: 'Policy override attempt',
    body: [
      'An attempt to override policy, claim staff authority, force a decision, or move an amount is refused. Detection happens at intake but the request is still allowed to reach the model, so that the audit trail can show the resolver discarding an untrusted proposal rather than the request simply disappearing. See `docs/adr/0002-injection-scope-and-limits.md`.',
      'The response is configurable through `INJECTION_ACTION`. **`deny`** is the default and refuses the request outright. **`escalate`** routes it to a human instead, on the reasoning that the detector is high-precision rather than high-recall: a false refusal costs a real customer their refund, which is a worse failure than a queued review. Neither setting can approve anything — escalation ranks below approval, and this clause never returns `approve`, so a flagged message is refused or reviewed, never paid.',
      'Escalation carries the eligible amount rather than $0, as every other escalation in this policy does, so the reviewing agent can see what is at stake.',
    ],
    ruleId: 'R-14',
  },
  {
    number: '8',
    title: 'Grounding',
    body: [
      'A model will happily assert `reason: "damaged"` about a customer who never mentioned damage. So every quote offered as evidence must be found in the customer\'s own message, character for character. A claim with no verified quote cannot approve anything — at worst it escalates.',
    ],
  },
  {
    number: '8.1',
    title: 'Minimum evidence quote',
    body: [
      `A quote shorter than ${MIN_EVIDENCE_QUOTE_LENGTH} characters cannot evidence a claim. It is discarded as noise, because a two-word fragment matches almost anything.`,
    ],
  },
  {
    number: '8.2',
    title: 'Minimum verified quotes',
    body: [
      `A grounded claim requires at least ${MIN_GROUNDED_QUOTES} verified quote${MIN_GROUNDED_QUOTES === 1 ? '' : 's'}. Rejected quotes are retained in the audit record, so a reviewer can see what the model claimed and why it did not count.`,
    ],
  },
  {
    number: '9',
    title: 'Decision precedence and authority',
    body: [
      `Outcomes fold by strict precedence: **deny** (${PRECEDENCE.deny}) beats **escalate** (${PRECEDENCE.escalate}) beats **approve** (${PRECEDENCE.approve}) beats **pass** (${PRECEDENCE.pass}). The single highest-precedence non-pass outcome across all rules is the decision. A tie is impossible because precedence values are distinct.`,
      'The resolver is the sole writer of the final decision. No rule writes a decision, and no model output is ever read as one. A model proposal may raise the bar on a decision but can never lower it: it cannot turn an escalation into an approval, and it cannot move an amount. The amount is always the eligible amount computed from order facts, and a proposal that disagrees is recorded as an override in the audit trail. See `docs/adr/0001-resolver-is-sole-authority.md`.',
      `Rule classes are constrained so that authority cannot leak. An **eligibility** rule may ${ALLOWED_OUTCOMES.eligibility.join(', ')}; an **approval-authority** rule may ${ALLOWED_OUTCOMES['approval-authority'].join(', ')}; a **risk** rule may ${ALLOWED_OUTCOMES.risk.join(', ')}; an **integrity** rule may ${ALLOWED_OUTCOMES.integrity.join(', ')}. These sets are asserted at evaluation time, so a rule that claims an outcome its class forbids fails the request rather than returning it.`,
    ],
  },
  {
    number: '10',
    title: 'Discretion',
    body: [
      'The clauses above are the policy. They are applied mechanically, and when they cannot reach a conclusion the safe default is escalation. That is correct for a rulebook and wrong for a customer: a good customer a few days past the window, a loyal member with a faulty toaster, a customer whose message is messy but clearly means "it arrived broken" - a person resolves these on the spot.',
      'The discretion layer is that judgement, encoded as deterministic rules rather than left to the model. It runs after the base policy and only ever softens an **escalation**; it never overrides a denial, which only a person can overturn. Every adjustment is recorded as an override in the audit trail, so a reviewer sees both the policy outcome and the discretion that softened it.',
      'The layer is off by default and every bound is an operator-controlled environment variable: the maximum amount it may authorise, the courtesy window, which alternatives it may offer, and the lowest evidence confidence it will accept. See `docs/adr/0003-discretion-layer.md`.',
      '**Decision outcomes.** `approved`, `denied` and `escalated` are the three outcomes the base policy produces. The discretion layer may also produce `partial_refund` (a reduced amount, which is reserved), `exchange` and `store_credit` (which resolve the request without moving refund money). No rule and no model ever produces these; only discretion does.',
    ],
  },
];

function sectionFor(spec: SectionSpec, rules: readonly PolicyRule[]): string[] {
  const rule = spec.ruleId === undefined ? undefined : rules.find((r) => r.id === spec.ruleId);
  const heading = spec.number.includes('.')
    ? `## §${spec.number} — ${spec.title}`
    : `# §${spec.number} — ${spec.title}`;
  const body = spec.body.map((paragraph) => `${paragraph}\n`);
  if (rule === undefined) {
    return [heading, '', ...body];
  }
  const metadata = [
    `| Rule | Stage | Scope | Class | May return |`,
    `| --- | --- | --- | --- | --- |`,
    `| \`${rule.id}\` | ${rule.stage} | ${rule.scope} | ${rule.ruleClass} | ${ALLOWED_OUTCOMES[rule.ruleClass].join(', ')} |`,
    '',
    `_${rule.summary}_`,
    '',
  ];
  return [heading, '', ...metadata, ...body];
}

/**
 * Section numbers declared by hand, rule ids declared by the rule objects. A
 * mismatch in either direction throws, which is what stops a new rule from
 * being added without a clause to justify it.
 */
function assertSectionsMatchRules(): void {
  const bySection = new Map<string, string>();
  for (const rule of POLICY_RULES) {
    const match = /§([\d.]+)$/.exec(rule.policyRef);
    const section = match?.[1];
    if (section === undefined) {
      throw new Error(`${rule.id} has an unparseable policyRef: ${rule.policyRef}`);
    }
    bySection.set(section, rule.id);
  }
  for (const spec of SECTIONS) {
    const actual = bySection.get(spec.number);
    const expected = spec.ruleId;
    if (actual !== expected) {
      throw new Error(
        `section §${spec.number} declares rule ${expected ?? 'none'} but ${actual ?? 'no rule'} is registered for it`,
      );
    }
  }
  const declared = new Set(SECTIONS.filter((s) => s.ruleId !== undefined).map((s) => s.number));
  for (const section of bySection.keys()) {
    if (!declared.has(section)) {
      throw new Error(`rule section §${section} has no clause in REFUND_POLICY.md`);
    }
  }
}

export function renderPolicyDocument(): string {
  assertSectionsMatchRules();
  const rules = POLICY_RULES;
  const chunks: string[] = [
    '# Refund Policy',
    '',
    '**Version 1.0.0.** This document is generated from the enforcing code by',
    '`apps/api/src/policy/policyDocument.ts`. Do not edit it by hand: change the rule, then run',
    '`pnpm policy:doc`. Every decision returned by the API carries the `policyRef` of the clause',
    'that produced it, so this file is the document an auditor is actually reading.',
    '',
  ];
  for (const spec of SECTIONS) {
    chunks.push(...sectionFor(spec, rules), '');
  }
  const table = [
    '## Appendix — rule index',
    '',
    '| Clause | Rule | Title | Class | Stage |',
    '| --- | --- | --- | --- | --- |',
    ...POLICY_RULES.map(
      (rule) =>
        `| ${rule.policyRef.replace('REFUND_POLICY.md ', '')} | \`${rule.id}\` | ${rule.title} | ${rule.ruleClass} | ${rule.stage} |`,
    ),
    '',
  ];
  chunks.push(...table);
  return `${chunks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
