# 0005 — Support-and-tracking shop assistant, not a shopping concierge

Date: 2026-10-06

## Status

Accepted.

## Context

The README scopes this product as order-aware support: a customer reports a
problem about their own order, the policy engine decides, a person reviews.
Broad product discovery, lifestyle recommendations, and a general storefront
concierge were deliberately out of scope, because they blur the trust model
between recommendations, order facts, and refund policy.

Support still needs to look things up. "Where is my order?", "how do I send
this back?", and "what replaces the mug that arrived broken?" are support
questions that need the catalogue and the order history, not general shopping
advice. Answering them without any product search forces customers back into
browsing by hand for something the assistant already knows.

## Decision

The assistant may answer support-adjacent lookup, and only that:

1. **Order status and tracking** for the signed-in customer's own orders.
2. **Return intent** routed through the existing returns workflow.
3. **In-catalogue replacement or buy-again suggestions** drawn from products the
   shop actually sells, priced from the database at checkout time.

It may not give open-ended lifestyle advice, rank products by taste, or invent
items. Catalogue search is literal keyword search (SQLite FTS5, no synonym
expansion), so a suggestion is always a row that matched the customer's own
words. The deterministic policy engine still owns every money decision
(ADR 0001): the model may nominate product ids, the server re-validates them
against the `products` table, and `checkout()` remains the only writer of
orders.

## Consequences

- `GET /api/shop/products` gains `q`, `inStock`, `maxPriceCents`, and `limit`
  filters backed by an FTS5 index (migration 21). No-query behaviour is
  unchanged.
- A slice-2 intent router will triage `order_status | return_intent |
  product_help` before the refund pipeline. Shop turns must never write a
  `refund_requests` row or reserve ledger money.
- The refund alias map in `retrieval/keywords.ts` stays refund-only; catalogue
  search does no synonym folding, so the two matchers cannot disagree through
  a shared table.

## Alternatives rejected

**General shopping concierge.** The trust model that makes refunds auditable —
model proposes, engine disposes — does not transfer to taste-based
recommendations, where there is no policy to dispose with.

**Embeddings now.** Fourteen products do not need vector search. FTS5 plus
price/stock filters answers the support questions with no new infrastructure;
embeddings can be revisited when the catalogue outgrows keywords.

**Model-priced checkout.** Letting the model name a total would be ADR 0001
violated through the shop back door: a compromised prompt could discount any
basket, and no field would record that a human had said so.
