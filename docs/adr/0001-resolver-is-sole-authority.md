# 0001 — The resolver is the sole authority for every decision

**Status:** Accepted. Enforced in code; referenced by `REFUND_POLICY.md §9`.

## Context

This system reads a customer's free-text refund request with a language model. That
model is good at one thing — deciding whether "the lamp arrived cracked, I want my
money back" is a damage claim — and it has no idea what this company will pay for.
It cannot see the order table, the payment state, the refund window, the abuse
history, or the rules.

A model is also not a policy document. It is a stochastic function that was trained
on text, not on this company's obligations. Ask it to "approve this refund" and it
will often oblige, because approval is a natural continuation of the conversation it
is imitating. Wiring its output into a payout path means a customer who phrases
their request persuasively gets a different answer than one who does not.

The failure mode is not a bug in the model. It is the design: any arrangement in
which model output can reach a money-moving field is a design that spends money when
the model is confidently wrong.

The specific threat is adversarial rather than accidental. The customer writes the
message, so the customer chooses the input. Anything the model reads is attacker-
controlled text. A design that trusts the model is a design that trusts the
attacker.

## Decision

`resolve()` in `apps/api/src/policy/resolver.ts` is the only function in the
codebase that constructs a `RefundDecision`. Rules *evaluate*; they do not decide.
A model's output arrives at the resolver as an inert value and is never read as a
decision, an amount, or an outcome.

> **Amended.** The intake layer no longer produces a proposal at all. `IntakeReply`
> is either one clarifying question or a `ClaimExtraction` — reason, condition,
> confidence, quotes, and the figure the customer asked for — so there is no field
> in the model contract that *could* hold an outcome. The decision below is
> therefore enforced by the type of the seam rather than by comparing a proposal
> after the fact. `ResolveInput.aiProposal` remains for any caller that has one
> (`ai_proposal_rejected` and the two `ai_proposed_approve_clamped_to_*` codes
> remain in `OVERRIDE_CODES`), and `reconcile()` now also records the two
> disagreements that a claim can still produce: the figure the customer asked for
> against the figure authorised (`amount_clamped_to_order_value`,
> `amount_zeroed_on_deny`), and a claim discarded because an integrity rule fired
> (`untrusted_extraction_discarded`).

Four properties follow, and each is a separate mechanism rather than a convention:

**1. Precedence is total and one-directional.**
`PRECEDENCE` assigns `deny: 3, escalate: 2, approve: 1, pass: 0`. The fold keeps the
highest, so a denial anywhere in the trace outranks an approval anywhere else, and
the strongest outcome in the trace wins. Ties are impossible because the values are
distinct. There is no code path on which a lower-precedence outcome overrides a
higher one.

**2. The safe default is escalation, never approval.**
When no rule reaches a conclusion, `decisionFrom()` returns `escalated`. The
uninteresting case — nothing matched — resolves to a human, because the cost of an
unnecessary review is an agent's afternoon, and the cost of a wrong approval is
someone else's money.

**3. The amount is computed, never proposed.**
`amountFor()` returns `0` for a denial and `gateResult.eligibleAmountCents`
otherwise. The figure is a sum of eligible item prices derived from the order
table. `aiProposal.suggestedAmountCents` is never an input to it.
`assertAmountSane()` then re-checks at the boundary that the amount is a non-negative
integer no greater than the order total, so even a future bug above the resolver
cannot emit a negative or over-total payout.

**4. Disagreement is recorded, not resolved in the model's favour.**
`reconcile()` writes an `OverrideRecord` whenever what the model read differs from
what the policy concluded — the figure the customer asked for against the figure
authorised, a denial that authorises nothing, and a claim thrown away as untrusted.
The audit trail therefore shows not just what was decided but what the model read
and the policy thought of it, which is the only way a reviewer can tell a working
system from a lucky one.

Two supporting decisions belong to this ADR because they exist to protect it:

- **Item-scoped outcomes are excluded from the precedence fold.** A final-sale item
  (§2.1) is an *adjustment* to the eligible set, not a refusal. If it could outrank
  an order-scoped approval, removing one item from a mixed order would silently deny
  the rest of it. The exclusion is already reflected in the amount; the evaluation
  stays in the trace for the auditor. `decidingRule()` implements this.
- **Rule classes cannot exceed a granted authority.** `ALLOWED_OUTCOMES` restricts
  eligibility, approval-authority, risk and integrity rules to different outcome
  sets, and `assertEvaluationsAllowed()` runs on every evaluation. A risk rule that
  tries to deny fails the request rather than returning the denial — the class
  contract makes "escalate quietly, deny loudly" impossible to express, not merely
  discouraged.

## Consequences

The model is reduced to what it is actually good at: extracting a reason and quoting
the customer. Every decision is reproducible from stored facts — the same order and
the same message always produce the same decision, with no dependence on a
third-party service being available, deterministic, or in a good mood. If the
provider is down, the system escalates instead of failing open, and the offline
test suite exercises the full policy path with no network at all.

The cost is that the model can never help. It cannot rescue a legitimate claim that
needs a reason the policy does not recognise, and it cannot soften a denial. A
judgement-heavy business needs a human in more cases than a marketing demo
suggests, and the escalation rate is a real operational cost that has to be staffed.

`llmCalled` is true whenever the model stage was reached, including when it failed.
Reporting it as "the AI decided" would be a lie; the field means the model was
consulted, and the trace says what it proposed.

A consequence worth stating plainly: because the amount comes only from the eligible
set, a model that sees no order facts (`AI_SHARE_ORDER_FACTS=false`) will routinely
propose `$0.00` and be clamped. Those clamp records are expected, not a defect, and
they are the visible proof that the authority boundary held.

## Alternatives considered

**Let the model output the decision and validate it afterwards.** Rejected. A
validator is only as strong as the thing it validates; a decision that is
post-hoc-checked against a rubric the model can influence is still a decision the
model made. The only validation that cannot be argued with is structural.

**Ask the model for a decision, then require a rule to *approve* it — treat the model
as a necessary condition rather than a sufficient one.** Rejected as more complex
for no gain. It still makes correctness depend on the model's availability and
calibration, and it introduces a failure mode where a correct policy outcome is
withheld because the model was terse. Making the model advisory removes the
dependency rather than managing it.

**Sandbox the model: give it a read-only view and a tool it must call to act.**
Rejected for this system. The tool boundary is the same idea as the resolver
boundary, expressed with more machinery and one more thing to get wrong. Worth
revisiting if the model ever needs to *choose among* policy outcomes rather than
merely classify a reason.

**Deterministic NLP on the server, no model at all.** Rejected as brittle across
the phrasing diversity of real customers. It is the right answer for a closed set of
intake forms and the wrong one for a chat channel. The current design keeps the
deterministic guarantees that matter and pays a bounded, budgeted cost for the
flexibility.
