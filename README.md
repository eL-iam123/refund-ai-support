# WORKNOON — Refund AI Support

A customer-support refund agent for a fictional electronics retailer. Customers
describe a problem in their own words; the system decides whether to refund, refuse,
or hand the case to a human — and can show its reasoning to an agent afterwards.

**The language model never decides anything.** It reads the message and proposes a
reason. A deterministic policy engine owns eligibility, amount, and outcome. This is
the central design constraint, and it is what separates this from a chatbot with a
refund button. See [ADR 0001](docs/adr/0001-resolver-is-sole-authority.md).

---

## What it does

- **Customer chat** — a real chat UI; the customer's message is the only input
- **Grounded extraction** — a model classifies the reason and quotes the customer;
  every quote is verified as a verbatim substring of their message
- **17-rule policy engine** — windows, final sale, digital goods, payment state,
  refundable balance, chargebacks, abuse signals, duplicate charges, request
  integrity
- **Three-way outcomes** — approve, deny, escalate to a human
- **Full audit trail** — every rule evaluation, every model attempt, every override
- **Human override** — an agent can change any decision, with a reason
- **Human payment approval** — an approved refund is *reserved*, not paid; an
  admin must verify it in the queue before money moves, and releasing a
  reservation returns the balance to the order
- **Conformance suite** — 18 scenarios pinning the behaviour, including the
  documented attack that the injection scanner is designed to miss

## Quick start

### One command, with Docker

```bash
cp .env.example .env        # uncomment one provider key and paste it in
docker compose up --build   # http://localhost:4000 - API, console and shop
```

That is the whole setup. The stack seeds 18 scenario fixtures, 20 customers, 25
orders and a short decision history on first boot, and serves the customer chat,
the agent console and the storefront from one origin.

A provider key is the one thing that cannot be invented, so it is the one thing
you have to supply. The server refuses to start without one and names the exact
variable, rather than accepting traffic it cannot answer.

`docker-compose.yml` ships a placeholder `ADMIN_API_SECRET` so the command above
works on a clean machine. It is rejected at boot when `NODE_ENV=production`, so
claiming to be a deployment means supplying a deployment's secrets:

```bash
NODE_ENV=production ADMIN_API_SECRET="$(openssl rand -hex 32)" docker compose up
```

### Without Docker

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env        # then add a provider key
pnpm seed                   # 18 scenario fixtures, dated relative to now
pnpm dev                    # API :4000, staff console :5173, shop :5174
```

Open http://localhost:5173. The customer view is `/`; the agent console is
`/admin`; the storefront is http://localhost:5174/shop/ (and, in a production
build, the same origin at `/shop`).

The staff console is gated. Mint a token first:

```bash
pnpm --filter @refund/api token --agent alice --role admin   # or --role agent
```

Paste it into the console once; it is kept in `sessionStorage` and attached to
every API call by `apps/web/src/api.ts`. `ADMIN_API_SECRET` must be set or the
server refuses to start.

## The shop

A small storefront on the *same SQLite database* as the refund engine, so buying
something and then disputing it is one continuous story rather than two
fixtures. `/shop` is served by the API in production, and proxies to the API in
dev.

- **Accounts** — register, or log in as a demo customer. Passwords are scrypt
  with a per-user salt; sessions are 256-bit random tokens stored only as
  SHA-256 hashes in an `HttpOnly`, `SameSite=Lax` cookie.
- **Catalogue** — six products chosen to exercise the policy, including a
  final-sale coat, a coffee subscription, a digital guide, and sealed
  headphones. Digital goods are never refundable and subscriptions are handled
  by a different rule, so the shop is a test bench for the rules, not filler.
- **Cart and checkout** — a real server-side transaction. Prices and totals are
  computed from the database and never accepted from the browser; stock is
  decremented in the same transaction that writes the order.
- **Orders** — a customer's real order history, and a report-a-problem form that
  posts to the actual `/api/chat/messages` pipeline. The decision, amount, and
  policy clause shown in the shop are the resolver's, not the browser's.

### Who the customer is

**`POST /api/chat/messages` takes a `customerId` in the body, and on its own it
trusts it.** The endpoint is public so a customer can reach it from a plain web
form, and there is no token on that route, so the id is a claim the customer
makes about themselves. Anyone who knows or guesses a `CUST-*` id can read that
customer's order history and refund history through the endpoint.

A valid `shop_session` cookie closes this for the storefront: the session's
customer wins, and the id in the body is ignored. The shop footer says so, and
`apps/api/src/http/routes/chat.ts` states the override in a comment so the next
reader does not have to rediscover it.

To close it properly, every caller needs a credential — put the chat endpoint
behind authentication, or issue the session cookie to every entry point. Do not
put a customer id in a query string or treat it as an identifier without
meaning that someone can assert one. See "Known limits".

### The refund path, end to end

```
browse  ->  add to cart  ->  checkout (stock + totals in one transaction)
                              ->  orders page lists what was bought
                              ->  report a problem, naming one item
                              ->  the pipeline runs against the real order
                              ->  decision, amount, and clause come back
                              ->  partial refunds are capped at the item named
```

The last line is worth stating because it is where the money is: the amount is
capped at the items the message actually disputes, and an item the customer
names *only to rule it out* — "the mug arrived broken, the lamp is fine" — is
not counted. Refunding the lamp there would be paying out money for an item the
customer just said was fine. That exclusion is
`scopeItems(..., message)` in `apps/api/src/retrieval/keywords.ts`, and its
edges are pinned in `apps/api/src/test/item-scope.test.ts`.

### Verification

```bash
pnpm verify        # typecheck + lint + test
pnpm test:live     # 124 assertions against a real provider (opt-in)
docker compose up --build     # the same image, as a deployment
```

`pnpm test` needs no network and no API key. It uses a deterministic fake analyzer
and exercises the real policy engine, resolver, and database.

## Architecture

```
packages/shared     Zod schemas, rule/outcome contracts, 18 conformance scenarios
apps/api            Fastify 5 + SQLite (better-sqlite3)
  src/policy/       the 16 rules, the gates, the resolver  <- authority lives here
  src/ai/           analyzer adapter, prompts, grounding   <- proposes only
  src/security/     injection scanner
  src/retrieval/    order identification and item scoping
  src/db/           schema, migrations, repositories
  src/auth/         staff tokens, roles, guards
  src/shop/         storefront accounts, catalogue, checkout
  src/http/         routes, serialization, error mapping
  src/response/     deterministic customer replies
apps/web            React 19 + Vite + react-router 7   (staff console, token-gated)
apps/shop           React 19 + Vite                     (storefront, /shop)
```

### The pipeline

Seven stages, and the ordering *is* the security property:

```
INTAKE → RETRIEVE → FACT GATES → AI ANALYSIS → REASON RULES → RESOLVER → RESPONSE
```

Fact gates can terminate before the model is ever called. Everything after the gates
can only make the outcome *stricter* — a model proposal can escalate a request, never
approve one.

| Stage | Owns |
|---|---|
| Intake | injection scan, customer lookup, R-14 |
| Retrieve | order, duplicate-charge sibling |
| Fact gates | item eligibility, windows, payment state, risk signals |
| AI analysis | **proposes** a reason + quotes; never decides |
| Reason rules | whether the proposed reason justifies a refund |
| Resolver | **the only writer of a decision and of the amount** |
| Response | deterministic text; the model never writes the reply |

### Why the model cannot decide

Four separate mechanisms, not one convention:

1. **Total precedence** — `deny (3) > escalate (2) > approve (1) > pass (0)`. The
   highest non-pass outcome in the trace wins. A denial anywhere outranks an approval
   anywhere else.
2. **The amount is computed** — `eligibleAmountCents` is a sum of eligible item prices
   from the order table. `suggestedAmountCents` is never an input. `assertAmountSane()`
   re-checks at the boundary that the amount is a non-negative integer no greater than
   the order total.
3. **Escalation is the default** — when no rule concludes, the request goes to a human.
   Never an automatic approval.
4. **Disagreement is recorded** — if the model proposed something else,
   `reconcile()` writes an `OverrideRecord` into the audit trail. You can always see
   what the model wanted versus what the policy decided.

## Configuration

Validated once at boot with Zod: a misconfigured deployment fails immediately and
loudly, not at the first customer request.

A `.env` file supplies **defaults**; the real environment **wins**. `API_PORT=8080
docker run …` is honoured even if a `.env` was baked into the image.

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `groq` | `groq` \| `openrouter` \| `openai` \| `nvidia` |
| `AI_MODEL` | per provider | Specific model id, **not** a router alias |
| `AI_FALLBACK_MODELS` | empty | Comma-separated, tried in order |
| `AI_TIMEOUT_MS` | `30000` | Per attempt |
| `AI_TOTAL_BUDGET_MS` | `45000` | Whole-request ceiling, including retries |
| `AI_MAX_ATTEMPTS` | `2` | Attempts per model |
| `AI_SHARE_ORDER_FACTS` | `false` | See below |
| `INJECTION_ACTION` | `deny` | `deny` \| `escalate` |
| `ADMIN_API_SECRET` | none | **Required.** `openssl rand -hex 32` |
| `MAX_MESSAGE_LENGTH` | `4000` | Enforced on the request, not by the shared schema |
| `DATABASE_PATH` | `./data/refund.sqlite` | |
| `CORS_ORIGIN` | localhost:5173,8080 | Comma-separated |

### Two amounts, and only one of them is money

`refundAmountCents` is the amount **authorised for payment**, and it is non-zero only
when the decision is `approved`. A `denied` or `escalated` decision returns `0` there,
even when the customer is plainly owed something.

The figure under review lives on `eligibleAmountCents`, which is order-derived and
independent of the decision. Keeping them apart is deliberate: a field called
`refundAmountCents` carrying $700.00 on a decision that a human has not yet made is
how an unauthorised payout gets queued, and whatever consumes this API next — a payout
job, a report, a CSV export — will read the field literally. The escalation still says
what is at stake, in `amount_not_payable_until_reviewed` on the trace.

### Choosing a model

Verify a model before trusting it. `GET /v1/models` advertises ids an account cannot
invoke — NVIDIA's list includes several that answer `404 not found for account` — and
of the ids that do run, many ignore `response_format` and spend the token budget on
prose instead of JSON.

Measured against this pipeline:

| Model | Result |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 3/3 valid, grounded, ~11s avg |
| `llama-3.3-70b-versatile` (Groq) | fast, schema-valid |
| `gpt-4o-mini` (OpenAI) | fast, schema-valid |

Budget for seconds, not milliseconds. A real generation here is ~11s, which is why
`AI_TOTAL_BUDGET_MS` sits above the worst observed call.

### `AI_SHARE_ORDER_FACTS`

Defaults to `false`: the model sees only the customer's own words. This is the
stronger guarantee, because a model that can see an order total can produce a
plausible-looking number the customer never mentioned and have the quote check pass
anyway.

The trade-off is visible in the audit trail. With sharing off, the model routinely
proposes `$0.00` and the resolver overrules it, logged as
`amount_clamped_to_order_value`. That record is the boundary working, not a defect.
Set it to `true` for a quieter trace at the cost of the stronger guarantee.

## Security model

**Threat: the customer controls the only input the model reads.** Everything else is
a consequence.

| Attack | Defence |
|---|---|
| Prompt injection ("ignore all previous instructions") | R-14 denies by default; and even a total scanner failure cannot move money, self-approve, or forge order facts |
| Model fabricates a reason the customer never gave | Grounding: every quote must be a verbatim substring of the message |
| Model invents or inflates an amount | Amount is order-derived and re-asserted at the boundary |
| Rule tries to exceed its granted authority | `ALLOWED_OUTCOMES` + `assertEvaluationsAllowed()` per class |
| Unbounded spend on retries | `AI_TOTAL_BUDGET_MS`, abort-aware backoff, `AI_MAX_ATTEMPTS` |
| Secrets leaking into logs or the database | Provider errors redacted before persistence; keys never logged |
| Forged `customerId` in a refund request | A `shop_session` overrides the body; ownership is re-checked in the order lookup regardless of the claimed id |
| An agent escalating themselves | Roles are enforced per route, and override is admin-only; `agentId` comes from the verified token, not the body |
| Non-English / obfuscated injection | **Not detected — by design.** Scenario S-18 asserts this |

The injection scanner is 17 English patterns, documented as high-precision rather than
high-recall. It is a filter, not a boundary. See
[ADR 0005](docs/adr/0005-injection-scope-and-limits.md) for why a miss is survivable.

`INJECTION_ACTION=escalate` exists because the scanner will eventually false-positive,
and a false denial costs a real customer their refund. It routes flagged messages to a
human instead. Neither setting can approve anything.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/health` | status and the active AI mode |
| `POST` | `/api/chat/messages` | the pipeline; returns decision, trace, extraction, grounding |
| `GET` | `/api/policy` | the live rule table, built from the enforcing objects |
| `GET` | `/api/scenarios` | the 18 conformance fixtures |
| `GET` | `/api/customers`, `/api/customers/:id/orders` | seeded fixtures, staff only |
| `GET` | `/api/requests`, `/api/requests/:id` | audit history, staff only |
| `POST` | `/api/requests/:id/override` | human override, admin only, with a required reason |
| `GET` | `/api/refunds?status=pending_verification` | the payment verification queue, staff read |
| `POST` | `/api/refunds/:id/settle` | verify and pay a reserved refund, admin only |
| `POST` | `/api/refunds/:id/release` | give a reservation back without paying, admin only, reason required |
| `GET` | `/api/whoami` | the identity the server attributes this session's actions to |
| `GET` | `/api/admin/stats` | dashboard counters, staff only |
| `GET` | `/api/shop/products` | the live catalogue |
| `POST` | `/api/shop/register`, `/api/shop/login`, `/api/shop/demo-login` | accounts |
| `POST` | `/api/shop/logout`, `GET /api/shop/me` | session lifecycle |
| `POST` | `/api/shop/checkout` | cart to order, transactionally |
| `GET` | `/api/shop/orders` | the signed-in customer's own orders |

### Overriding the policy

`POST /api/requests/:id/override` is the only way around every control in the
system, so it is graduated by what the override actually does:

| Override | Allowed |
|---|---|
| Any denial, or re-opening a refusal for human review | Always. Moves no money, and blocking it would stop a person giving a customer a hearing. |
| Approving something the policy never hard-refused | Always. The ordinary goodwill case. |
| Approving over a **hard block** — R-01 window, R-02 final sale, R-05 downloaded digital goods, R-06 payment state, R-06b refundable balance, R-14 policy-override attempt | Only with `acknowledgeHardBlock: true` and a note. `409` otherwise, naming the rules. |
| Approving an order **already refunded in full** | Never. `409`, no acknowledgement unlocks it — the money has already gone out, so this is a double payment, not a judgement call. |

The amount is always re-derived from the order. There is no field in the request to
set, and the write path refuses any decision/amount pair that could be read as an
unauthorised payment — see "Two amounts" above.

### Approved is not paid

An approval reserves money. It does not move any. The two are separate facts,
stored separately, because conflating them is how a refund system pays the same
customer twice.

| State | What it means | Where it lives |
|---|---|---|
| `approved` | The policy agreed this amount. | `refund_requests.decision` |
| `pending_verification` | The amount is held against the order so nothing else can claim it. Nobody has looked at it. | `refunds.status` |
| `settled` | A person checked it and the money went out. Only now does `orders.refunded_cents` move. | `refunds.status` |
| `released` | The approval was undone. The balance returns to the order and the customer can claim it again. | `refunds.status` |

The flow:

```
POST /api/chat/messages  ->  approved          -> refunds row: pending_verification
                                                   orders.refunded_cents: unchanged
admin opens /admin/refunds
POST /api/refunds/:id/settle                   -> refunds row: settled
                                                   orders.refunded_cents: + amount
                                                   audit_events: refund_settled, named after the token
```

Rules that fall out of it:

- **R-06b** denies a claim once the refundable balance is gone. The balance is the
  order total, less everything settled, less everything still pending. Counting
  pending approvals as spent can refuse a claim the business would have honoured,
  and the fix for that is a reviewer settling the queue — not a rule that lets one
  order be promised several times over.
- **One row per request** (`UNIQUE request_id`), so re-running the pipeline for a
  request cannot reserve the same money twice.
- **One row per idempotency key** (`UNIQUE idempotency_key`, derived from
  request, order and amount), so a retried payment is recognisable to a processor
  as the same payment rather than a second one.
- **Settling twice is a `409`**, not a second payment. A reviewer double-clicking
  is a normal event, not a fault.
- **Settlement is admin-only.** Approving a refund is a policy call the pipeline
  reaches on its own; issuing one spends the company's money.
- **An override that undoes an approval releases its reservation** in the same
  transaction. A reservation that outlives the decision that created it would
  silently shrink what the customer can claim for the rest of the order's life.
- **The table's `CHECK` constraints refuse an unreviewed settlement** — a `settled`
  row must name who checked it and when, and a `released` row must say why.

What is *not* here: a payment processor. `settled` means a human confirmed the
refund, not that a bank transfer was initiated. When an executor is added it
sends `idempotency_key`, and this ledger is what makes that call safe to retry.

### Staff authentication

Staff routes require `Authorization: Bearer <token>`; missing, malformed, forged
and expired tokens all get `401`, and an agent token on an admin-only route gets
`403`. Roles are `agent` (read requests, read catalogue and stats) and `admin`
(plus override). `GET /api/health`, `GET /api/policy`, `GET /api/scenarios` and
`POST /api/chat/messages` are deliberately public so a customer can reach the
assistant and read the policy without an account.

Tokens are HMAC-SHA256 over `agent.role.expiry`, signed with
`ADMIN_API_SECRET`. The secret is required at startup — there is no default and
no dev bypass, because a default would be a way in. It must be at least 32
characters, and the container refuses to start without a real provider key, both
checked at boot rather than at the first customer request.

`GET /api/admin/audit/verify` is admin-only and re-walks the audit chain on
demand, naming the id of the row that fails. It returns `200` with `ok: false`
when the chain is broken, because a broken chain is a finding to read, not a
failed request.

## Testing

```
345 passed · 8 skipped · 0 network required
```

The 8 skipped are the opt-in live provider suite, which stays dark unless
`LIVE_AI_TESTS=1`.

`src/test/refund-ledger.test.ts` is the money suite worth reading first: it covers
the reservation/settlement split, double-reservation, double-settlement, the
over-refund refusal, release, reinstatement, and the two endpoints that move
money. `src/test/migrations.test.ts` carries the drift case - a database
recorded as current but structurally behind - which is a real failure this
project hit rather than a hypothetical one.

- **18 conformance scenarios** drive the full pipeline through the production code
  path with a deterministic fake analyzer. Each asserts decision, amount, and the
  specific rule that decided it.
- **Grounding tests** — invented quotes are rejected; verified ones survive.
- **Injection tests** — all four categories detected, honest refund requests *not*
  flagged, and S-18 confirmed undetected.
- **Staff auth tests** — `401` for missing/malformed/forged/expired tokens, `403`
  for an agent on an admin route, and the customer chat endpoint left open.
- **Shop tests** — registration, login, demo login, session binding, checkout,
  stock, order isolation, and that a shop session overrides a forged body
  `customerId`.
- **Item-scope tests** — a product named only to be ruled out is excluded from the
  refund ceiling, and the exclusion does not narrow order identification.
- **Migration tests** — a legacy database without the newer columns is upgraded in
  place, and the real on-disk file is opened as well as the in-memory one.
- **Drift test** — `REFUND_POLICY.md` is regenerated from the rule objects and
  compared byte-for-byte. Edit a rule without running `pnpm policy:doc` and the suite
  fails.
- **Live tests** — `pnpm test:live` hits a real provider and asserts schema validity
  *and* grounding, then runs the whole pipeline against S-01. Opt-in. It skips only
  genuine transport failures, never a malformed response.

## The policy document

[`REFUND_POLICY.md`](REFUND_POLICY.md) is **generated from the code that enforces it**.
Section numbers come from each rule's own `policyRef`; titles, classes, stages, and
allowed outcomes come from the rule objects. Only the clause prose is authored.

```bash
pnpm policy:doc
```

A test regenerates it in memory and compares it to disk, so the published policy and
the enforced policy cannot drift apart. Every decision the API returns carries the
`policyRef` of the clause that produced it — which is only meaningful because the
clause exists and says what the rule does.

## Assumptions and trade-offs

Places where a reasonable person would have built it differently, and why this
one is like this.

- **One container instead of three services.** The storefront is served by the
  API process, so its session cookie is first-party. Behind a separate domain the
  same cookie is third-party and the browser drops it, which would mean a login
  that silently does not work. That is a real cost: you cannot scale the frontend
  independently, and the image is larger than three small ones would be.
- **The model proposes; the policy decides.** Every amount, decision and rule
  trace comes from deterministic code, and the LLM is only ever a source of
  structured claims that are grounded against the customer's own words. This is
  the central design choice. The trade-off is real and worth stating plainly: the
  model can never *help*, so a legitimate claim resting on a reason the rules do
  not recognise escalates instead of being approved. A system optimised for
  approval rates would be less correct, not more useful.
- **Approvals reserve, humans pay.** An approval holds the money and a person
  releases it. This deliberately slows refunds, and it means a queue has to be
  staffed. The alternative - approving straight to a payment call - turns a wrong
  decision into an irreversible one.
- **No mock or offline mode in the running product.** Tests inject a fake
  analyzer; the application always talks to a real provider. That is why a
  provider key is required to start.
- **Fail fast on misconfiguration.** Missing keys, weak secrets and invalid config
  stop the process at boot instead of surfacing on the first customer request. An
  empty variable counts as absent, so a missing key is reported as a missing key
  rather than as a malformed optional.
- **SQLite, single writer.** The audit chain is sequential by id and the ledger
  assumes one process, so a second replica on the same volume is not a scale-out.
  Everything here is sized for a single-writer deployment.

## Known limits

- **`POST /api/chat/messages` trusts the `customerId` in the body.** It is public
  by design, so a caller who knows a `CUST-*` id can see that customer's orders
  and refund history. A `shop_session` cookie fixes it for the storefront and
  overrides the body; nothing fixes it for an unauthenticated caller. This is the
  first thing to fix before exposing the endpoint.
- The injection scanner misses translated and obfuscated attacks. Deliberate, asserted
  by S-18, and bounded by the resolver.
- Escalation volume is a real operational cost that has to be staffed. The model can
  never *help* — it cannot rescue a legitimate claim needing an unrecognised reason.
- Item scoping is keyword-based. It handles "the mug arrived broken, the lamp is
  fine" but it reads a mention as a claim unless the same clause calls the item
  intact, so an unusual phrasing that mentions a healthy item in a clause without
  an intact marker can still widen the ceiling. The resolver is the backstop, and
  this is the most likely source of a wrong amount.
- Refund decisions are recorded, not executed. There is no payment processor, so
  there is no idempotency key on an outbound transfer and no lock across processes.
- Single-tenant, single-currency (USD), SQLite. Not a multi-merchant ledger.

## Licence

MIT. Fictional retailer, fictional customers, fictional orders.
