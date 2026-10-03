# 0004 — The item picker is a question, not a form field

Date: 2026-10-02

## Status

Accepted.

## Context

The storefront asked which order line a claim was about *before* the conversation
began. `ChatPage.mustPickItem` refused to send the customer's message and opened a
picker instead, so a customer who had already typed "it's broken" was held at a
list of buttons until they chose one. Two things were wrong with that, and only one
of them was cosmetic.

The cosmetic one is that it read as a form. The composer would not send, so the
control felt like a field the customer had to satisfy rather than a question the
assistant had asked.

The structural one is where the picker sits in the system. Order lines are not a
presentation detail. `disputeCeiling()` in `retrieval/identifyOrder.ts` builds the
ceiling from the resolved lines, and that ceiling caps what an approval can pay:
`item-scope.test.ts` pins it as "the lamp the customer never claimed cannot be
inside an approval". So the question of *who* decides the scope is a question
about money.

Today the answer is comfortable. `identifyOrder` derives the scope from the
customer's ticked ids, falling back to a deterministic keyword matcher.
`ClaimExtraction.items` — the model's own guess at which lines are at issue — is
read by exactly one consumer, `handoffBrief.ts`, for display. The model has never
touched the scope.

That separation is the whole asset, and any redesign has to preserve it.

## Decision

The picker becomes something the assistant can offer inside the conversation, and
it stays something the customer answers.

1. **The model may ask; only the customer may answer.** A third tool,
   `ask_which_items`, lets intake request the picker and nominate the ids it could
   not tell apart. Those ids are a hint: they are re-validated against the
   resolved order, and an id that is not on it is dropped. The scope that reaches
   the money arrives as the customer's own `itemIds` on their next message, through
   the same field a hand tick uses. There is no code path from model output to the
   dispute ceiling, and `retrieval/itemPicker.ts` is where that is enforced — by
   returning a list to render and nothing else.

2. **The model asks; the server decides.** `itemPickerOffer` can only say yes or
   withhold, and every condition in it can only withhold: the scope is already
   resolved; the order has one line; the eligible amount is below the floor, so
   choosing cannot change what is paid; a prior offer exists on this thread; the
   message carries an injection signal; the fact gates already ended the request; a
   person is already engaged. A model that asks on every turn therefore cannot
   produce a picker on every turn. A decline is a normal outcome: the request
   continues with no claim, which escalates to a person — the right destination for
   an ambiguity nobody will settle.

   *Amended during implementation.* This ADR originally gave the server the trigger
   as well as the veto, offering the picker on its own initiative whenever a claim
   left the scope unresolved. That was built and reverted: "the customer did not
   name an item" is the **default** for an ordinary complaint, so the trigger fired
   on the majority of multi-line claims and turned 46 tests across the scenario,
   HTTP and pipeline suites into picker turns. The fixtures were right to object.
   The rule tests exist to pin one rule each, and quietly turning every ambiguous
   claim into an extra round trip turns a rule suite into a picker suite — and the
   $25 floor does not discriminate enough to prevent it. The model asking is also
   the better trigger, because it has read the message: it knows when it could not
   tell two lines apart, and a matcher cannot.

3. **The offer is not model prose.** `ask_which_items` carries ids and no free
   text. `ask_question` may put model words in front of a customer because those
   words *are* the answer; here the answer is a set of buttons, and a caption would
   be a second interface competing with the first. The caption is deterministic.

4. **The composer stops gating.** `mustPickItem` and the modal picker are deleted.
   A message is never withheld for want of a selection, and "the whole order"
   becomes a claim a customer can make rather than one they fall into by ticking
   nothing. A small per-line chip row remains under the composer, because
   "proactively" and "only when asked" are different products — but it is a
   modifier on the message, never a gate in front of it.

5. **The offer is a turn, and it survives a reload.** It is stored on
   `shop_dialogue` as `assistant_offer_json` (migration 18), holding the lines as
   they were offered. Replaying a picker as a prose question would leave a customer
   reading "which item is this about?" with no way to answer it, and storing the
   prices freezes what they were shown.

## Consequences

- The offer can only ever **narrow** a claim. Picking nothing leaves it whole,
  which is what already happens when the matcher cannot tell the lines apart.
- The negation heuristic in `scopeItems` — "only the mug arrived broken, the lamp
  is perfect" — stops being load-bearing for the common case. It remains as the
  fallback when nothing is ticked, which is the right place for a heuristic.
- One extra turn when the offer fires, paid only when the choice is material.
- A wrong-moment picker is the main UX risk, which is what the deterministic
  predicate and the once-per-thread bound exist to prevent.
- The scope the customer confirms is visible to staff in the handoff brief and in
  the `amount_limited_to_disputed_items` override, instead of a mismatch surfacing
  there first.

## Alternatives rejected

**Let the model choose the lines.** It would be one field smaller and it would make
the picker feel smarter. It also makes the model the author of the dispute ceiling,
which is ADR 0001 violated through the item-scope back door: a compromised prompt
would cap a refund to whatever it liked, and there would be no field recording that
a human had said so.

**Have the model decide *whether* to ask.** Then the conditions above become advice
rather than gates, and the failure mode is a picker on every turn. Advisory is the
right word for the request and the wrong word for the decision.

**Keep the picker as a pre-conversation modal and add the tool alongside it.** Two
ways to say the same thing about the same order, and the modal would keep the
composer feeling like a form. The chips keep the capability without the gate.

**Ship the server-side predicate first and the model tool later.** The right way
round, but it is not what happened. The predicate shipped *as the gate on* the tool,
not as a trigger in its own right, because the two are not separable: the predicate
is what makes the tool trustworthy, and without a trigger to attach it to it is
dead code. If the gate turns out to withhold nearly every request in production,
`ask_which_items` should be reconsidered rather than loosened — the conditions in
it are the difference between a tool and a trap.

**Let the heuristic `LocalAnalyzer` ask for the picker.** It could: "named no item"
is a pattern, and it would give the development and demo environment the feature
without a key. It was not done, for the same reason as the server trigger —
`LocalAnalyzer` is what the scenario fixtures run against, so a picker there turns
every rule assertion into an intake assertion. The consequence is honest and worth
stating: with `AI_PROVIDER=local` or no API key, the picker does not appear, because
a pattern matcher has no reason to ask which line is meant. The feature needs a
model.