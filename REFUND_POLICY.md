# Refund Policy

**Version 1.0.0.** This document is generated from the enforcing code by
`apps/api/src/policy/policyDocument.ts`. Do not edit it by hand: change the rule, then run
`pnpm policy:doc`. Every decision returned by the API carries the `policyRef` of the clause
that produced it, so this file is the document an auditor is actually reading.

# §1 — Scope and definitions

This policy governs automated refund decisions for delivered orders. It is enforced in code by the ordered rule list in `apps/api/src/policy/rules/`, and every decision the API returns carries the `policyRef` of the clause that produced it.

**Definitions.** *Eligible item*: an order item that has passed every item-scope eligibility clause. *Eligible amount*: the sum of eligible item prices, in integer cents, never the amount the customer asked for and never the amount a model proposed. *Grounded claim*: an extracted reason supported by at least one quote verified as a verbatim substring of the customer's own message.

**What this policy is not.** It is not a description of what the language model does. The model reads the message and proposes; it never decides. See §9.

# §2 — Eligibility

These clauses establish whether the order or the item is refundable at all. They run before any reason is considered, and a denial here is final.

Item-scope clauses adjust the eligible set rather than terminating the request on their own, so a blocked item reduces the refund instead of cancelling it.

## §2.1 — Final sale items

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-02` | fact_gates | item | eligibility | deny, pass, approve |

_Items marked final sale are not eligible for refund._

An item marked `finalSale` is not refundable for any reason, including damage. It is excluded from the eligible set, which reduces the refundable amount but leaves the rest of the order refundable.

## §2.2 — Digital goods already downloaded

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-05` | fact_gates | item | eligibility | deny, pass, approve |

_Digital licences that have already been downloaded are not refundable._

A digital item that has been downloaded cannot be refunded. A digital item that has not been downloaded is treated as an ordinary physical item.

## §2.3 — Payment already settled or refunded

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-06` | fact_gates | order | eligibility | deny, pass, approve |

_Fully refunded, or unsettled, orders cannot be refunded again._

An order whose payment state is `refunded` and whose refunded amount already covers the order total cannot be refunded again. An order whose payment is still `pending` cannot be refunded, because there is no settled funds to return.

## §2.4 — Subscription and renewal charges

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-10` | fact_gates | order | eligibility | deny, pass, approve |

_Recurring and renewal charges are handled by billing, not refunds._

A subscription or automatic renewal charge is not refundable through this flow. It requires a billing specialist, because reversing a renewal re-grants service the customer may still be using.

## §2.5 — No refundable balance remaining

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-06b` | fact_gates | order | eligibility | deny, pass, approve |

_An order cannot be refunded beyond what was paid, counting approvals already awaiting verification._

An order cannot be refunded beyond what the customer paid. The refundable balance is the order total less everything already settled against the order, less every approval that is still waiting for a person to verify it.

Counting approvals awaiting verification as spent is deliberate. It can refuse a claim the business would have honoured, and the remedy for that is a reviewer settling the queue. The alternative, treating an unverified approval as though it were free to issue again, lets one order be promised several times over while the first promise sits unread - and every one of those promises becomes money the business does not have.

Because approval reserves money rather than moving it, a claim that was approved and later denied has its reservation released, and the balance returns to what it was.

# §3 — Refund windows

Windows are measured in days from the delivered timestamp. An order with no delivery timestamp cannot pass either window clause.

## §3.1 — Standard refund window

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-01b` | reason_rules | order | approval-authority | escalate, pass |

_Claims older than 30 days need a verified fault or human review._

A refund is **standard** if the request is made within 30 days of delivery, counted from the delivered timestamp and not from the order date.

## §3.2 — Absolute refund window

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-01` | fact_gates | order | eligibility | deny, pass, approve |

_Orders older than 45 days from delivery are never refundable, whatever the reason._

45 days after delivery is the **absolute outer limit**. Nothing is refundable past it, whatever the reason given. There is no exception, no goodwill path and no agent override at this stage.

# §4 — Approval authority

These clauses bound what the automated flow may approve on its own. They cannot approve, only escalate or pass, so a request that clears every other clause still lands with a human if the amount is large enough.

## §4.1 — Human review above threshold

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-03` | fact_gates | order | approval-authority | escalate, pass |

_Refunds above $500.00 require human review._

A refund of more than $500.00 against a single order requires human review. This is checked against the **order total**, before item-level denials are applied, so an order cannot be split to evade it.

## §4.2 — Threshold re-check on eligible remainder

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-03b` | fact_gates | order | approval-authority | escalate, pass |

_Records that the amount threshold was re-evaluated after item-level denials._

When item-level clauses (§2.1, §2.2) reduced the eligible amount below the order total, and that reduction is exactly what brought the request under the review threshold of §4.1, the reduction is recorded explicitly in the audit trail.

This clause never decides anything. It exists so the outcome is legible to an auditor instead of looking accidental.

# §5 — Reason rules

These clauses decide whether a *reasoned* refund is warranted. They require a grounded claim: the reason must be quoted from the customer, not inferred. An ungrounded or absent reason can never approve.

## §5.1 — Damaged or incorrect goods

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-04` | reason_rules | order | eligibility | deny, pass, approve |

_Verified damage or an incorrect item qualifies for automatic approval._

A refund is approved when the customer's own words describe goods that arrived damaged, faulty, or not as described, and the order is otherwise eligible. The model may only classify which of these reasons applies; it cannot create the claim.

## §5.2 — Duplicate charge

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-11` | reason_rules | order | eligibility | deny, pass, approve |

_A same-day duplicate of an identical order is refunded without fuss._

Where a same-day, same-value sibling order exists for the customer, one of the two charges is a duplicate. The request is approved for the duplicate only, and only when the sibling order is identified rather than assumed.

## §5.3 — No grounded reason in the request

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-12` | reason_rules | order | approval-authority | escalate, pass |

_A request with no verifiable reason escalates to a human._

A request that reaches the reason stage without a grounded reason escalates. It does not deny: the customer may have a legitimate reason they did not write down, and a human can read the order. A claim needs at least 1 verified quote to be considered at all (§8).

# §6 — Risk signals

Risk clauses escalate to a human. They never deny. A signal is a reason to look closer, not proof of wrongdoing, and refusing on a signal alone would punish a customer for something the policy has not established.

## §6.1 — Open chargeback on the order

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-07` | fact_gates | order | risk | escalate, pass |

_An in-flight chargeback means a refund could pay the customer twice._

An order with an open chargeback is already in dispute. Refunding it as well would pay twice, so the request escalates.

## §6.2 — Refund abuse signals

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-08` | fact_gates | order | risk | escalate, pass |

_Independent risk signals escalate to human review; they never deny._

Three independent signals are counted: an account younger than 7 days, at least 3 prior refunds on record, and at least 3 refund requests in the last 30 days.

At least 2 independent signals are required to escalate. A single signal is recorded and passed, because a burst of refunds can be a genuine run of bad luck.

## §6.3 — Conflicting customer and fulfilment evidence

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-09` | reason_rules | order | risk | escalate, pass |

_A non-delivery claim that contradicts signed delivery records escalates._

Where the customer reports goods as damaged but fulfilment evidence records them as delivered intact and signed for, the two accounts conflict. Neither is disproved by the other, so the request escalates for a human to weigh.

## §6.4 — Order reference cannot be resolved

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-13` | fact_gates | order | risk | escalate, pass |

_An unmatched order reference escalates rather than denies._

A request naming an order that does not exist, or that belongs to a different customer, escalates. It is not denied: a mistyped or mistated reference is not an attempt to defraud, and a human can find the right order.

# §7 — Request integrity

The request channel is untrusted. These clauses treat the message as data to be parsed, never as instructions to be followed.

## §7.1 — Policy override attempt

| Rule | Stage | Scope | Class | May return |
| --- | --- | --- | --- | --- |
| `R-14` | intake | order | integrity | deny, escalate, pass |

_Attempts to override policy, force a decision, move an amount, or claim authority are denied._

An attempt to override policy, claim staff authority, force a decision, or move an amount is refused. Detection happens at intake but the request is still allowed to reach the model, so that the audit trail can show the resolver discarding an untrusted proposal rather than the request simply disappearing. See `docs/adr/0002-injection-scope-and-limits.md`.

The response is configurable through `INJECTION_ACTION`. **`deny`** is the default and refuses the request outright. **`escalate`** routes it to a human instead, on the reasoning that the detector is high-precision rather than high-recall: a false refusal costs a real customer their refund, which is a worse failure than a queued review. Neither setting can approve anything — escalation ranks below approval, and this clause never returns `approve`, so a flagged message is refused or reviewed, never paid.

Escalation carries the eligible amount rather than $0, as every other escalation in this policy does, so the reviewing agent can see what is at stake.

# §8 — Grounding

A model will happily assert `reason: "damaged"` about a customer who never mentioned damage. So every quote offered as evidence must be found in the customer's own message, character for character. A claim with no verified quote cannot approve anything — at worst it escalates.

## §8.1 — Minimum evidence quote

A quote shorter than 4 characters cannot evidence a claim. It is discarded as noise, because a two-word fragment matches almost anything.

## §8.2 — Minimum verified quotes

A grounded claim requires at least 1 verified quote. Rejected quotes are retained in the audit record, so a reviewer can see what the model claimed and why it did not count.

# §9 — Decision precedence and authority

Outcomes fold by strict precedence: **deny** (3) beats **escalate** (2) beats **approve** (1) beats **pass** (0). The single highest-precedence non-pass outcome across all rules is the decision. A tie is impossible because precedence values are distinct.

The resolver is the sole writer of the final decision. No rule writes a decision, and no model output is ever read as one. A model proposal may raise the bar on a decision but can never lower it: it cannot turn an escalation into an approval, and it cannot move an amount. The amount is always the eligible amount computed from order facts, and a proposal that disagrees is recorded as an override in the audit trail. See `docs/adr/0001-resolver-is-sole-authority.md`.

Rule classes are constrained so that authority cannot leak. An **eligibility** rule may deny, pass, approve; an **approval-authority** rule may escalate, pass; a **risk** rule may escalate, pass; an **integrity** rule may deny, escalate, pass. These sets are asserted at evaluation time, so a rule that claims an outcome its class forbids fails the request rather than returning it.

## Appendix — rule index

| Clause | Rule | Title | Class | Stage |
| --- | --- | --- | --- | --- |
| §7.1 | `R-14` | Policy override attempt | integrity | intake |
| §2.1 | `R-02` | Final sale items | eligibility | fact_gates |
| §2.2 | `R-05` | Digital goods already downloaded | eligibility | fact_gates |
| §3.2 | `R-01` | Absolute refund window | eligibility | fact_gates |
| §2.3 | `R-06` | Payment already settled or refunded | eligibility | fact_gates |
| §2.5 | `R-06b` | No refundable balance remaining | eligibility | fact_gates |
| §2.4 | `R-10` | Subscription and renewal charges | eligibility | fact_gates |
| §6.1 | `R-07` | Open chargeback on the order | risk | fact_gates |
| §6.2 | `R-08` | Refund abuse signals | risk | fact_gates |
| §6.4 | `R-13` | Order reference cannot be resolved | risk | fact_gates |
| §4.1 | `R-03` | Human review above threshold | approval-authority | fact_gates |
| §4.2 | `R-03b` | Threshold re-check on eligible remainder | approval-authority | fact_gates |
| §3.1 | `R-01b` | Standard refund window | approval-authority | reason_rules |
| §5.1 | `R-04` | Damaged or incorrect goods | eligibility | reason_rules |
| §6.3 | `R-09` | Conflicting customer and fulfilment evidence | risk | reason_rules |
| §5.2 | `R-11` | Duplicate charge | eligibility | reason_rules |
| §5.3 | `R-12` | No grounded reason in the request | approval-authority | reason_rules |
