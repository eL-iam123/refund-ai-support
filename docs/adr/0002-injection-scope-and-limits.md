# 0002 — Injection detection: scope, limits, and why a miss is survivable

**Status:** Accepted. Enforced by `apps/api/src/security/injection.ts` and
`REFUND_POLICY.md §7.1`.

## Context

The customer writes the message, and the message is the only thing the model reads.
Every token in it is chosen by the party with the most to gain from a wrong answer.
That makes the input adversarial by construction, and it means "the model will
refuse if you ask it nicely" is not a security property.

The honest framing is that this is a **prompt injection** problem, and the fashionable
answer is a better detector: a classifier, a canary token, an LLM judge, a growing
pattern list. Those all raise recall, and all of them are the wrong primary defence
for a system that moves money. A detector is a filter in front of a trust boundary,
and a filter that can be evaded is not a boundary. If correctness after a miss
depends on the detector being right, then the detector *is* the security system, and
it will eventually be wrong.

The question worth answering is not "how do we catch every injection?" — it is
"what happens when we miss one?"

## Decision

Two decisions, deliberately separated.

**1. The scanner is high-precision, not high-recall, and it is not the security boundary.**

`scanForInjection()` matches four categories in English and nothing else:
`policy_override`, `decision_manipulation`, `role_impersonation`, and
`amount_manipulation`. It is 17 patterns — 6 for policy override, 5 for decision
manipulation, 6 for role impersonation, plus a fourth category (`amount_manipulation`)
that needs two signals to fire at all. It will miss translated, obfuscated, novel,
and low-effort attacks, and **the codebase asserts this rather than hoping it**:
scenario `S-18` is a non-English payload that deliberately defeats the scanner, and
the test suite requires that it does. A system claiming immunity here would be making
a promise it cannot keep.

Two refinements keep the false-positive rate low enough to be deployable:

- `amount_manipulation` requires **two** signals, not one. A demanded figure on its
  own is a customer asking for money, which is what the channel is for. It only
  counts as an attack when it arrives alongside a policy, authority, or
  decision-manipulation demand. Without this rule, S-06 — "refund my $450 order" —
  would be refused as an attack instead of escalated for review, and the scanner
  would have made the system worse at its actual job.
- Zero-width characters are stripped before matching, so `ig\u200bnore the refund
  policy` cannot slip past a pattern. Zero-width and base64 markers are recorded as
  `obfuscationNoted` for the audit trail but deliberately do not affect the
  decision: flagging "this looks odd" as a denial reason trains operators to ignore
  the signal.

**2. Because the scanner is best-effort, the consequences of a miss are bounded
structurally rather than by the scanner.**

This is the part that matters, and it is inherited from
[ADR 0001](./0001-resolver-is-sole-authority.md) rather than reimplemented:

- A request that gets past the scanner still cannot **move money**, because the
  amount is `eligibleAmountCents` — a sum of eligible item prices from the order
  table — and never `aiProposal.suggestedAmountCents`. `assertAmountSane()`
  re-checks at the boundary that the amount is a non-negative integer no greater
  than the order total.
- It still cannot **approve itself**. The resolver is the only writer of a decision,
  and the model's only power is to raise the bar. An injected "approve this" can at
  worst make the system *more* suspicious, never less.
- It cannot forge facts, because the order, customer, payment state, and window come
  from SQLite, not from the message.

So the worst outcome of a total scanner failure is that a hostile request is decided
on its merits — which is exactly the answer S-18 asserts: the non-English injection
is not caught, and the order is still decided purely on facts, approving the $130
the order supports and ignoring the $9000 demanded.

**Detection is deliberately not terminal.** R-14 runs at intake and its outcome is
folded in at resolve, so a hostile message still reaches the model and the audit
trail can show the claim read from it — the amount it asked for authorising nothing
— and then discarded (`untrusted_extraction_discarded`). Dropping the request
silently at intake would make the system safer in the narrow sense and un-auditable
in the one that matters: a reviewer could not distinguish an attack that was caught
from one that never happened.

*Amended after ADR 0001: nothing is "clamped" here any more, because the model
proposes no outcome. What the record shows is a claim that was read and thrown
away.*

## Consequences

The system's security no longer rests on the pattern list, so improving the list is
an enhancement rather than a P0. Deleting all 17 patterns would not create a money
path — it would cost us the audit signal and the R-14 denial on obvious attacks.

The cost is that obvious attacks *are* refused while equivalent-but-obscured ones
reach a human or are decided on facts. That asymmetry is visible to an attacker,
who will learn to obfuscate. It is the correct trade here: obfuscation buys an
attacker a queue ticket, not a payout.

Escalation cost is real and worth stating. On the `escalate` setting, a determined
attacker submitting fluent non-English override attempts generates agent workload
at zero cost to themselves. That is a denial-of-service surface, and it is the
reason `deny` is the default rather than `escalate`. The setting exists so an
operator can choose which failure they would rather have, not because one is
correct in the abstract.

`INJECTION_ACTION` is validated at boot against the same `INJECTION_ACTIONS` union
that R-14 branches on, so the config and the code cannot drift into disagreeing
about what values exist. It is read in exactly one place (`buildContext`) and
threaded through `PipelineDeps` like any other dependency, which means tests can
drive both branches without touching module state.

An earlier version of this codebase declared `INJECTION_ACTION` in the environment
schema and then never read it. An operator setting `escalate` would have got a
silent no-op and a false sense of configuration. The four tests in
`policy.test.ts > INJECTION_ACTION` exist because that failure is invisible at
runtime; only an assertion that the branch is reachable catches it.

## Alternatives considered

**A second model call as a judge ("is this message an injection?").** Rejected.
A judge model is itself injectable, is another network dependency in the
authorization path, and doubles latency to protect a boundary that is already
structural. It also converts a deterministic, auditable regex into a probabilistic
one, which is a downgrade for a system whose selling point is reproducibility.

**Unicode/encoding normalisation plus a much larger pattern list, as the primary
defence.** Rejected as an arms race with no terminal state. Normalisation is worth
having — the zero-width stripping is kept for exactly that reason — but it only
buys specific bypasses, and each new pattern increases false positives on honest
customers. §6.2 already shows what a broad rule does to real traffic: it refuses
people who have had bad luck.

**Strip the message of anything resembling an instruction and process only the
remainder.** Rejected as lossy in a way that matters here. The customer's own words
are the evidence grounding depends on; rewriting the message before grounding it
would break the verbatim-quote check, which is the one thing keeping the model
honest.

**Treat detection as terminal and refuse at intake.** Rejected for the audit reason
above: it hides the attempt instead of recording it, and it converts a
high-precision filter into a single point of failure for the whole channel.
