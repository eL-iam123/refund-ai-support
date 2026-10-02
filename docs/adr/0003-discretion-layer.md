# 0003 — The discretion layer: automatic, bounded, auditable judgement

**Status:** Accepted. Enforced in code by `apps/api/src/policy/discretion.ts` and
`apps/api/src/policy/resolver.ts`; referenced by `REFUND_POLICY.md §10`.

## Context

ADR 0001 made the resolver the sole writer of every decision and reduced the model
to a messenger. That is the right security model, and it has a cost the ADR names
plainly: *"the model can never help. It cannot rescue a legitimate claim that needs
a reason the policy does not recognise, and it cannot soften a denial."*

The cost is not theoretical. The base policy is a rulebook: hard windows, hard
eligibility exclusions, a review threshold, and a safe default of escalation. It
handles the straightforward cases correctly and then fails the way a mechanical
system fails a person:

- A good customer a few days past the 30-day window is escalated, not refunded.
- A loyal plus-member with a faulty toaster is escalated, not recognised.
- A customer whose message is messy but clearly means "it arrived broken" is
  escalated because the model's evidence quote was not verbatim.
- A claim that is not a refundable fault - a change of mind, a late delivery -
  gets "a person will review this" and no alternative.

Every one of these is a case a human assistant resolves in seconds. The result is
an escalation queue full of cases that did not need a person, and customers who
feel the system does not care.

The question is how to get human-like judgement without giving up the security
model. The answer is to encode the judgement as **deterministic, configurable,
auditable rules** - the same trade a human override makes, made in advance and
within pre-authorised bounds.

## Decision

`recommendDiscretion()` in `apps/api/src/policy/discretion.ts` is a pure function
of order facts, the extraction, the grounding result and an operator-controlled
config. The resolver consults it **only when the base decision is `escalated`**
and applies its recommendation within bounds. Four properties hold, and each is a
mechanism rather than a convention:

**1. It only ever softens an escalation.** A denial is a denial. Discretion never
overrides one; only a person can (`overrideGuard.ts`). This is the line that keeps
the layer from becoming a way around the eligibility clauses.

**2. It is deterministic and configurable.** The same order, customer and message
always produce the same recommendation. Every bound - the maximum amount, the
courtesy window, which alternatives may be offered, the lowest evidence confidence
- is an environment variable read in one place (`discretionConfig`). The layer is
**off by default**, so a deployment that does not opt in decides exactly as it did
before.

**3. It is auditable.** Every adjustment is recorded as an `OverrideRecord` with
its own code (`discretion_approve`, `discretion_partial_refund`,
`discretion_exchange`, `discretion_store_credit`), so the audit trail shows both
the policy outcome and the discretion that softened it. This is the same visibility
a manual override has.

**4. The model is not involved.** `recommendDiscretion` reads no model output. The
model's proposal remains inert data, the resolver remains the sole writer of the
decision, and precedence is untouched. ADR 0001 is preserved in full: the layer is
a set of rules, not the model deciding.

### New decision outcomes

The alternatives the layer can produce required three new `Decision` values:

| decision | refundAmountCents | money |
| --- | --- | --- |
| `approved` | = eligible | reserves full |
| `partial_refund` | 0 < x ≤ eligible | reserves partial |
| `exchange` | 0 | no reservation |
| `store_credit` | 0 | no reservation |

`partial_refund` is a payment, so it is reserved by `persistDecision` and
restricted by `overrideGuard` exactly as an approval is. `exchange` and
`store_credit` resolve the request without moving refund money; fulfilling them is
out of scope for this pass.

### The rules, in priority order

1. **Courtesy window** - a grounded fault on an order within the operator's
   courtesy window past 30 days.
2. **Loyalty** - a plus/enterprise member with a qualifying fault within the
   pre-authorised amount.
3. **Low-value auto-approve** - a small, clearly-faulted claim.
4. **Partial refund** - a genuine fault on a claim larger than the pre-authorised
   amount.
5. **Exchange / store credit** - a plausible claim that is not a refundable fault.
6. **Near-miss quote** - an almost-verbatim evidence quote on a low-risk,
   low-value claim. Off by default, because this is the one place the grounding
   guarantee is relaxed.

## Consequences

The escalation rate falls, and the cases that remain in the queue are the ones
that genuinely need a person. Customers get alternatives instead of a flat "a
person will review this". The model is still a messenger; the resolver is still
the sole authority; every decision is still reproducible from stored facts.

The cost is that the layer can be wrong in the direction of paying when it should
not. That is bounded by the pre-authorised maximum and by the fact that it only
ever softens an escalation - it cannot turn a denial into a payment, and it
cannot widen what is refundable. An operator who disagrees with a rule switches
it off or lowers its bound; no code change is needed.

Because the layer is off by default, the eighteen-scenario suite is unchanged: with
discretion disabled, every decision is exactly what it was.

## Alternatives considered

**Let the model decide.** Rejected for the reasons in ADR 0001: a model that can
decide is a model that can be talked into deciding, and the customer chooses the
input.

**Add the alternatives as more rules in the base policy.** Rejected. A rule that
approves a change-of-mind is a rule that approves every change-of-mind, which is
not a discretion policy, it is a different policy. The point of discretion is that
it is bounded, configurable and off by default.

**A second model call as a judge.** Rejected for the reasons in ADR 0002: a judge
model is itself injectable and doubles latency to protect a boundary that is
already structural.

**Only improve the conversation, leave the decision rigid.** Rejected as
insufficient. A warm "a person will review this" is still a dead end for a customer
who needed an exchange. The decision itself has to be able to offer one.
