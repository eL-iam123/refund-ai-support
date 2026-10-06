# 0006 — General conversation beside the refund pipeline, not through it

Date: 2026-10-06

## Status

Accepted.

## Context

Customers expect a ChatGPT-style assistant: greetings answered, help
questions explained, policy questions quoted, vague wording understood. The
refund pipeline answers none of that well - every message becomes a claim
extraction, so "hello" earns an interrogation and "what is your return
policy" becomes a case file. But letting the model decide refunds would trade
away the property the whole system rests on: the deterministic engine is the
sole authority for money (ADR 0001).

## Decision

One router, two destinations, decided by deterministic patterns before any
model is called (`response/shopIntent.ts`):

1. **Refund-shaped stays in the pipeline.** Money asks, fault language, person
   requests, injection probes, and anything unclear. The default is a person,
   never a paragraph: escalation is the safe answer to ambiguity.
2. **Everything else is answered conversationally and persisted as a shopping
   thread** (`shop_assistant_turns`), which the refund transcript, the ledger,
   and the staff queue never read. Greetings and empty sends get a fixed
   courtesy (no model, no cost); explicit general and policy questions get a
   model reply under contract.
3. **The model proposes, the policy disposes - in both directions.** Product
   nominations are re-resolved against the catalogue; conversational prose is
   schema-checked and guard-checked (`ai/replyGuard.ts`: no outcome language,
   no figures, no order facts) with a deterministic fallback. A rejected
   sentence costs a canned line, never a customer-facing hallucination.
4. **Tone is inferred, not stored** (`response/tone.ts`): the last few customer
   turns set concise/friendly/detailed per request. A profile in the database
   would be a judgement about a person kept past the conversation it served.
5. **Claim extraction is unchanged.** `ClaimExtraction` already carries the
   structured draft (intent, orderRef, reason, condition, amount, items,
   evidence, confidence); the resolver, discretion, consent gate, and R-15
   validate it exactly as before.

## Consequences

- `POST /api/chat/messages` gains a fourth answer shape (`shopAnswer`,
  now also `kind: 'general'`); no `refund_requests` row is written for it,
  asserted by tests that count both tables.
- Greetings no longer enter the refund thread: the "greeting is not a request"
  suite now asserts a conversational answer, zero model calls, and zero staff
  queue presence.
- Two adapters grew an optional `converse` method; absent (local, unavailable,
  test doubles) means the deterministic fallback, which is also the no-key
  behaviour.

## Alternatives rejected

**Model decides refunds.** Harder to audit, easier to manipulate, less
policy-safe - the exact tradeoff this system was built to refuse.

**Single pipeline for every message.** Preserves one code path and destroys
the experience: greetings interrogated, policy questions filed as cases.

**Persisted tone profiles.** Personalisation that outlives its conversation is
surveillance with a friendly name.
