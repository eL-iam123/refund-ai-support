# 0007 — The model phrases the reply; the envelope owns the facts

**Status:** Accepted. Amends the response row of the pipeline table: the model
may now write customer-facing words, under the contract below. ADR 0001 is
otherwise unchanged - the resolver remains the sole authority for every
decision, and no model output reaches any money-moving field.

## Context

The deterministic composer is always correct and always sounds like a form.
Customers told us so by re-asking: a reply that reads as a script gets treated
as a script, and the follow-up it provokes costs more than the warmth would
have. The proposal under discussion is the reader/writer split: one model
call decodes the request into a claim, the policy engine decides, and a
different model call phrases the decided outcome into prose.

The danger is the one ADR 0001 names: any arrangement in which model output
can reach a money-moving field spends money when the model is confidently
wrong. Phrasing looks safe right up until the model writes "$900", "denied"
on an approval, or a timeline nobody promised - at which point the words *are*
the payout expectation, whatever the ledger says.

## Decision

`phraseReply()` in `apps/api/src/orchestrator.ts` runs strictly after the
resolver, on both the gated and the analysed path, and it works like this:

1. **The envelope is built deterministically** (`response/envelope.ts`) from
   the decision and the order: one outcome, pre-rendered amount strings, product
   names resolved from the order, the deciding reason in plain words, and
   sentences to include verbatim (timing, next step). No model is involved.
2. **The writer sees only the envelope** plus the customer's name, message, one
   verified quote at most, recent history, and a tone hint. No order totals, no
   trace, no extraction, no rule ids. A writer that cannot see a fact cannot
   leak or invent one - the prompt surface is minimal on purpose.
3. **The validator checks the prose against the envelope and nothing else**
   (`isSafePhrasedReply`): every currency-like token must resolve to an
   allowed amount string; no rival outcome family may appear; every `mustSay`
   sentence must be present verbatim (and is then stripped before the
   remaining checks, so required wording can never trip them); no timelines,
   guarantees, credentials, rule ids, or order references beyond the envelope.
4. **Anything else falls back** to `composeDeterministicResponse`, which is
   unchanged and remains the no-model path. No analyzer, failed call, empty
   reply, overlong reply, or validator rejection ever fails or delays a
   decision - the decision is already stored by then; only the wording is at
   stake.

Four properties carry over from ADR 0001, restated for prose:

**1. The check is structural, not judgemental.** The objection in ADR 0001 -
"a validator is only as strong as the thing it validates" - applies to
validators that grade meaning. This one matches closed string sets: amounts
against pre-rendered strings, outcomes against fixed verb families, required
sentences by substring. There is nothing to argue with because there is
nothing to interpret.

**2. The failure direction is fallback, never silence and never invention.**
Every failure mode - unavailable analyzer, thrown call, empty text, overlong
text, failed envelope match - returns the deterministic sentence. A rejected
phrasing costs one provider call, not a customer.

**3. The writer cannot move money because there is no money in its world.**
The envelope carries no order total, no eligible balance, no ledger state, and
no outcome to choose: a single `outcome` field to echo. The threat model that
treats the provider as compromised (`wild.test.ts`) still holds, because even
a fully jailbroken writer can only produce strings the validator then refuses.

**4. Separation of privilege between the two calls.** The reader never
receives response-generation instructions, and the writer never receives
extraction authority or order facts. Each prompt's attack surface is minimal,
which is precisely what makes prompt injection hard: the injected text in the
customer's message meets a reader that can only fill a claim schema, and a
writer that can only fill an envelope.

## Consequences

- Every decided turn now costs up to one extra provider call inside the
  existing total budget, and p99 latency on the provider path rises by
  definition. The staged progress UI absorbs it; the fallback absorbs failure.
  If the fallback rate climbs, the feature is decoration - watch
  `respond`-stage log lines, not vibes.
- `responseText` in stored rows and DTOs is now model phrasing whenever it
  passed validation, deterministic text otherwise. Tests pin the fallback and
  the validator matrix, never live wording.
- Thinking stays off on both calls: reasoning burns the token budget the
  prose needs (`NO_THINKING`), and neither JSON extraction nor short-form
  phrasing repays it. Revisit only with measurements, per ADR 0006's rule.

## Alternatives considered

**Phrasing with the full order and trace in context, "so it sounds informed".**
Rejected. Every fact in context is a fact the reply can misstate; the envelope
is minimal on purpose, and "informed" is what the order page is for.

**Requiring the reply to contain the envelope's outcome word.** Rejected as
theatre: it rejects good paraphrases ("we cannot refund this") while adding
no safety beyond the rival-outcome ban, which already prevents stating the
wrong decision. The validator bans lies; it does not grade style.
