# Refund AI Support

A customer-support refund agent for a fictional electronics retailer. Customers
describe a problem in their own words; the system decides whether to refund, refuse,
or hand the case to a human — and can show its reasoning to an agent afterwards.

**The language model never decides anything.** It reads the message and proposes a
reason. A deterministic policy engine owns eligibility, amount, and outcome. This is
the central design constraint, and it is what separates this from a chatbot with a
refund button. See [ADR 0001](docs/adr/0001-resolver-is-sole-authority.md).

---

## What it does

This project is intentionally a support assistant for a customer's own orders, not a
broad shopping concierge. The assistant is scoped to the problem a customer is
reporting about an order: damaged items, incorrect deliveries, refund questions,
policy explanations, and escalation to a human when the issue needs review.

- **Customer support chat** — a real chat UI scoped to the signed-in shopper and
  their own orders; the customer's message is the only claim input
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
- **Customer appeals** — a denied request can be appealed; the appeal appears in
  the agent queue and the takeover thread, closing when the agent overrides
- **Takeover photos** — during a live takeover, both agent and customer can attach
  images (JPEG, PNG, GIF, WebP ≤ 5 MB) that are stored on disk and served under
  `/media/`
- **Live queue analytics** — admin-only `/api/staff/analytics` shows open takeovers,
  escalated-awaiting count, money awaiting review, decisions today by outcome, and
  average takeover duration; rendered as a metrics strip on the Live page
- **Conformance suite** — 18 scenarios pinning the behaviour, including the
  documented attack that the injection scanner is designed to miss

### Scope boundary

This assistant is intentionally not a general shopping adviser. It is not built to
answer broad product-discovery questions, make lifestyle recommendations, or act as
an all-purpose storefront concierge. The product's strongest value is order-aware
support: helping someone explain an issue, decide whether the written policy allows
money back, and hand off to a human when the problem needs a person.

That boundary is deliberate. A broad shopping assistant would blur the trust model
between product recommendations, order facts, and refund policy, and this project's
core design constraint is that the policy engine owns money decisions.

### Support operations boundary

The admin backend is scoped to refund support operations, not general storefront
administration. Staff pages review live customer issues, open handoffs, appeal
status, override decisions, and policy-driven payment approvals. They are not a
catalogue management console, a marketing dashboard, or a general commerce
command center.

This separation matters. The admin console exists to review and resolve customer
problems at the policy boundary, not to manage the whole store. The shop and the
staff console therefore share the same domain model and the same trust rules: the
policy engine owns the decision, and a person only reviews or overrides it.

## Quick start

### One command, with Docker

```bash
docker compose up --build   # http://localhost:4000 - API, console and shop
```

That is the whole setup. The storefront items seed themselves on boot — the
catalogue is the one thing that is, because it is the shop's stock rather than
invented activity, and seeding it is idempotent and additive. There are **no**
demo customers, orders or history: register an account and buy something to
exercise the flow yourself, so what you see is what actually happened.

To re-run the catalogue seed by hand (safe, and it picks up any item added
since), it is the same code the boot path calls:

```bash
docker compose exec api node apps/api/dist/db/seed-cli.js
```

**To use a real model, paste your key into `.env` and restart.** That is the
entire procedure:

```bash
cp .env.example .env
echo 'AI_API_KEY=paste_your_key_here' >> .env
docker compose up
```

The provider is worked out from the key, so any of them works with no other
setting. None of them is required, and none is the default:

| Your key starts with | Provider used |
| --- | --- |
| `sk-` | OpenAI |
| `sk-ant-` | Anthropic |
| `AIza` | Gemini (free tier) |
| `nvapi-` | NVIDIA (free tier) |
| `sk-or-v1-` | OpenRouter (free tier) |
| `gsk_` | Groq (free tier) |

A key whose prefix is not in that table is refused at boot rather than guessed
at, because the only available guess is a vendor you never named. Set
`AI_PROVIDER` explicitly for a self-hosted or OpenAI-compatible endpoint, and
`AI_BASE_URL` alongside it.

`AI_PROVIDER=local` explicitly runs the development pattern matcher with no
network, and is refused when `NODE_ENV=production`. It is never selected
implicitly: an empty provider/key configuration reports the model as unavailable
and escalates claims rather than silently running heuristics.

**No key is needed to run the product.** With no key the server starts, reports
the model as unavailable on the staff dashboard and storefront, and every
request that would need a claim escalates to a human. A missing model is a degraded queue, which is
recoverable; a service that refuses to boot has no queue at all. Set
`AI_REQUIRED=true` for a deployment that must not run that way — see
[Configuration](#configuration).

**The staff console is off until you turn it on.** It is not a hidden link with
a login form behind it — with no operator account configured, `/admin` is not
rendered and every staff route answers `404`, so a fresh clone has no admin
surface to find. Two lines in `.env` and a restart bring it back:

```bash
echo 'ADMIN_USERNAME=admin' >> .env
echo 'ADMIN_PASSWORD=refund-desk-demo' >> .env     # or: openssl rand -base64 24
docker compose up
```

`admin-login.txt` holds the demo pair and what happens when you sign in. That
exact password is refused when `NODE_ENV=production`, because it is printed in a
file in this repository.

A production run wants a real model and a real password:

```bash
NODE_ENV=production ADMIN_USERNAME=ops \
  ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  AI_API_KEY=paste_your_key_here docker compose up
```

### Without Docker

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env        # then add a provider key
pnpm dev                    # API :4000 and the combined shop/staff client :5173 (catalogue seeds on boot)
```

Open http://localhost:5173. The storefront/customer view is `/`; the staff
console is `/admin`. Both use the same Vite client and API proxy during
development; in production the API serves that same built client from one
origin.

The staff console needs `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`; without
them `/admin` does not exist. Set them, restart, and sign in at `/admin` with that
username and password. The result is an httpOnly `SameSite=Lax` cookie that every
API call carries — no token is ever handed to the browser's JavaScript, so a
script injected into the storefront cannot read an operator's session out of it.
`admin-login.txt` has the demo pair.

For a script rather than a browser, mint a token that carries the same authority:

```bash
pnpm --filter @refund/api token --agent alice --role admin   # or --role agent
```

## The shop

A small storefront on the *same SQLite database* as the refund engine, so buying
something and then disputing it is one continuous story rather than two
fixtures. `/shop` is served by the API in production, and proxies to the API in
dev.

- **Accounts** — register and sign in. Passwords are scrypt with a per-user salt;
  sessions are 256-bit random tokens stored only as SHA-256 hashes in an
  `HttpOnly`, `SameSite=Lax` cookie.
- **Catalogue** — fourteen products chosen to exercise the policy and the price
  bands, from a $9 pin set to a $1,299 monitor. A final-sale coat, a coffee
  subscription, a digital guide and sealed electronics each trigger a different
  rule, and the items either side of the $500 human-review threshold are there
  so the amount rules can be seen to fire. A test bench for the rules, not filler.
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
  src/policy/       the 17 rules, the gates, the resolver  <- authority lives here
  src/ai/           analyzer adapter, prompts, grounding   <- proposes only
  src/security/     injection scanner
  src/retrieval/    order identification and item scoping
  src/db/           schema, migrations, repositories
  src/auth/         staff sign-in, session cookie, tokens, roles, guards
  src/shop/         storefront accounts, catalogue, checkout
  src/http/         routes, serialization, error mapping
  src/response/     deterministic customer replies
apps/web            React 19 + Vite + react-router 7   (storefront and staff console)
```

One client, not two. The storefront and the staff console are different audiences
with different trust levels, but they are the same origin and the same code - the
console is behind a sign-in, the shop behind a session cookie - and splitting
them into separate apps only bought a second build, a second deploy and a second
thing to fall out of date with the first.

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

### The assistant asks before it assumes

The model's two tools are `ask_question` and `decide_claim`; there is no third. A
request is decided in one turn when the customer has said enough, and the model is
expected to ask when it has not.

- **An ask is a question, never a decision.** It returns `200 { question, dialogueId }`,
  writes no `refund_requests` row, and is stored as dialogue — so a refresh keeps
  the exchange.
- **Asks are anchor-neutral.** A turn is recorded with no order until the customer's
  answer resolves one; the ask is then adopted onto that order, so the answer is
  decided against the conversation that asked it and the customer's thread reads as
  one continuous conversation.
- **The deterministic half.** When the message genuinely spans more than one of the
  customer's own orders (equal product matches), order resolution stays unresolved
  and the pipeline asks *which order* — a coin flip is never resolved as a pick.
  A single unresolved reference escalates rather than confirming or denying an
  id's existence.
- **Grounding spans turns.** The claim's quotes are checked against every *customer*
  line in the dialogue transcript plus the current message — an earlier turn is
  citable, the assistant's own wording never is.

### When the customer needs a person

A customer who is not being settled takes the thread over to a human. The switch
is explicit and reversible, and the two sides talk on the WebSocket, not through
the pipeline.

- **A live takeover.** `POST /api/staff/conversations/:customerId/take-over` is a
  *claim* — one handoff row at a time per customer, so a colleague who already saw
  the conversation gets the thread, and racing attempts are answered `409`. Only
  the staff member who holds the row may message or hand it back. While the
  handoff is live the pipeline is *paused*: a customer message is recorded to the
  human thread, relayed to the open staff sockets, and answered by the agent —
  never by the analyzer.
- **The case file is built, not claimed.** Every takeover opens the same briefing,
  derived from the thread at read time: the customer's own words, the assistant's
  restatement of them, the questions it asked and the answers, the evidence it
  actually secured (echoed quotes), the policy trail with the rules it ran, and
  any risk flags. The human is not re-deriving what the machine established. A
  conversation never got an order yet — the assistant is mid-clarify — opens just
  as well, anchored on the customer alone.
- **Notices are derived, never stored.** The one line the customer sees during a
  takeover — "Connecting you to a customer agent - please hold." — is rendered
  from the live handoff row, not written to the database, and disappears when the
  agent hands the thread back. When the handoff ends the pipeline resumes exactly
  where it would have: an unanswered customer message left over the takeover runs
  the next time the customer writes.
- **The agents' room.** `/admin/live` keeps an open WebSocket to the staff room;
  the shop keeps one per customer. The socket carries only "something moved" —
  every side re-reads its list or thread — so a message can never be delivered to
  the wrong browser.

### Replay is not your queue

Every list row and detail carries `source` — `scenario` when the request came from
a replayed fixture, `storefront` when a live customer made it — and the queue can
filter on it. The tag is derived from the row's `scenarioId`, never written at
request time, so a replayed run cannot masquerade as a customer.

The seed writes storefront items only, so a fresh deployment has an empty queue
that fills with nothing but real work. The distinction still earns its place: it
is what lets replay-based testing point at the same console without contaminating
what an operator sees.

## Configuration

**This section is the setup instructions.** `.env` deliberately holds only the
values you change and a line saying "see README.md" — prose in a file that
gets copied, pasted and merged tends to rot silently, and a stale comment in
`.env` is worse than no comment at all.

Validated once at boot with Zod: a misconfigured deployment fails immediately and
loudly, not at the first customer request.

A `.env` file supplies **defaults**; the real environment **wins**. `API_PORT=8080
docker run …` is honoured even if a `.env` was baked into the image.

### The two that matter

Nothing is required to start. These are the two that decide what the product can
do once it is running.

| Variable | Why |
|---|---|
| `ADMIN_USERNAME` + `ADMIN_PASSWORD` | The operator account. Both or neither: without them the staff console does not exist, `/admin` is not rendered, and every staff route answers `404`. The demo pair is in `admin-login.txt` and is refused in production. |
| `AI_API_KEY` | The model key, whatever provider it is for — the provider is inferred from its prefix. Optional: without it the product runs and escalates. Set `AI_REQUIRED=true` to make it mandatory. |
**No key is committed to this repository, and that is deliberate.** A key in git
is a key in every clone, every image layer and every fork, permanently and
publicly; the honest fix is a key that is not here. Per-provider variables
(`NVIDIA_API_KEY`, `GEMINI_API_KEY`, and so on) still work for a setup that keeps
its keys separate, and take second place to `AI_API_KEY` when both are set.

`ADMIN_API_SECRET` is optional. When set it signs staff sessions and tokens, so
rotating it invalidates every outstanding session at once; when unset the signing
key is derived from `ADMIN_PASSWORD`, which is enough for the console to work and
means the ordinary setup is two variables rather than three.

**A missing key is not an error by default.** The server starts, the assistant
has no model behind it, every request that needs a claim escalates to a person,
and the storefront and the staff console both say so plainly. It never falls back
to guessing: a queued service that escalates is recoverable, a service that
quietly approves on keyword matches is not.

That default is right for evaluating the product and for an operator mid-fix, and
wrong for a deployment that is supposed to *be* the model — there, every request
still succeeds, still escalates, and the dashboard still looks healthy while
nothing is being read. So there is a switch:

| `AI_REQUIRED` | Effect |
| --- | --- |
| unset | Required in production, tolerated in development |
| `true` | Refuse to start unless the selected provider has a key |
| `false` | Boot and escalate, even in production |

Set `AI_REQUIRED=true` and a missing key stops the process with a message naming
the variable and where to set it, rather than becoming a queue nobody is reading.
It never makes a failure quieter than it already is: the degraded mode already
logs an error at startup, shows a red banner on the staff dashboard, and records
the reason against every request it touches.

```
AI_REQUIRED=true
```

Nothing else needs setting to run. Every variable below has a default.

### Everything else

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | per provider | Overrides the provider inferred from the key. `local` runs the pattern matcher |
| `AI_MODEL` | per provider | Specific model id, **not** a router alias — see below |
| `AI_FALLBACK_MODELS` | empty | Comma-separated, tried in order. Failover across models beats retrying one: a rate-limited model usually stays rate-limited |
| `AI_TIMEOUT_MS` | `30000` | Per attempt |
| `AI_TOTAL_BUDGET_MS` | `45000` | Whole-request ceiling, including retries and the repair pass. This is the number a customer actually waits, so keep it above the worst observed call |
| `AI_MAX_ATTEMPTS` | `2` | Attempts per model |
| `AI_MAX_TOKENS` | `700` | ~5x a valid extraction. Higher is not safer: a model that ignores JSON mode spends the budget on prose and returns nothing parseable |
| `AI_SHARE_ORDER_FACTS` | `false` | See below |
| `INJECTION_ACTION` | `deny` | `deny` \| `escalate`. What a detected policy-override attempt does |
| `MAX_MESSAGE_LENGTH` | `4000` | Enforced on the request, not by the shared schema — it is a token-cost control, so it belongs to the deployment |
| `DUPLICATE_WINDOW_HOURS` | `72` | How far back a repeat of the same complaint counts as the same report. 72h spans a weekend, which is the commonest case: sent Friday, heard nothing, sent again Monday |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `30` / `1 minute` | Applied across HTTP routes, including health and authentication endpoints; the in-memory limiter is per process |
| `DATABASE_PATH` | `./data/refund.sqlite` | |
| `CORS_ORIGIN` | localhost:5173,8080 | Comma-separated |
| `API_PORT` / `API_HOST` / `LOG_LEVEL` / `NODE_ENV` | `4000` / `0.0.0.0` / `info` / `development` | |
| `WEB_STATIC_DIR` | unset | Only for serving a built client from the API. Unset in dev, where Vite serves it |

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

Name a specific model, not a router. OpenRouter's `openrouter/free` was measured
returning an empty body, and a 2775-character chain of thought truncating mid-JSON,
because it routes to whatever is healthy and many of those ignore
`response_format: json_object`. The adapter fails over safely, so this costs a wasted
round trip rather than correctness — but there is no reason to pay it.

Budget for seconds, not milliseconds. A real generation here is ~11s, which is why
`AI_TOTAL_BUDGET_MS` sits above the worst observed call.

To exercise the heuristic analyzer without an account, explicitly set
`AI_PROVIDER=local` in development. That is a pattern matcher with no key and no
network; it is refused when `NODE_ENV=production`, because a refund approved by
a regex is not a decision anyone can audit. Leaving the provider and key unset
does not activate it: the unavailable analyzer escalates requests instead.

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
[ADR 0002](docs/adr/0002-injection-scope-and-limits.md) for why a miss is survivable.

`INJECTION_ACTION=escalate` exists because the scanner will eventually false-positive,
and a false denial costs a real customer their refund. It routes flagged messages to a
human instead. Neither setting can approve anything.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/health` | status and the active AI mode |
| `POST` | `/api/chat/messages` | signed-in customer support pipeline; session-scoped customer, returns decision, trace, extraction, grounding |
| `GET` | `/api/policy` | the live rule table, built from the enforcing objects |
| `GET` | `/api/scenarios` | the 18 conformance fixtures, staff only |
| `GET` | `/api/customers`, `/api/customers/:id/orders` | customer records and their orders, staff only |
| `GET` | `/api/requests`, `/api/requests/:id` | audit history, staff only |
| `POST` | `/api/requests/:id/override` | human override, admin only, with a required reason |
| `GET` | `/api/refunds?status=pending_verification` | the payment verification queue, staff read |
| `POST` | `/api/refunds/:id/settle` | verify and pay a reserved refund, admin only |
| `POST` | `/api/refunds/:id/release` | give a reservation back without paying, admin only, reason required |
| `GET` | `/api/whoami` | the identity the server attributes this session's actions to |
| `POST` | `/api/admin/login` \| `/logout` \| `GET /session` | staff sign-in, session cookie, sign-out. `404` when no operator account is configured |
| `GET` | `/api/admin/stats` | dashboard counters, staff only |
| `GET` | `/api/shop/products` | the live catalogue |
| `POST` | `/api/shop/register`, `/api/shop/login`, `/api/shop/demo-login` | accounts |
| `POST` | `/api/shop/logout`, `GET /api/shop/me` | session lifecycle |
| `POST` | `/api/shop/checkout` | cart to order, transactionally |
| `GET` | `/api/shop/orders` | the signed-in customer's own orders |
| `GET` | `/api/shop/chat/history`, `/summary` | this customer's own conversation for an order |
| `GET` | `/api/shop/assistant-status` | whether a model is reachable, no customer data |
| `GET`, `POST` | `/api/returns` | the signed-in customer's own returns; open one |
| `GET` | `/api/returns/:id` | one of them, or `404` for anyone else's |
| `GET` | `/api/admin/returns`, `/api/admin/returns/by-request/:requestId` | the warehouse queue, staff only |
| `POST` | `/api/admin/returns/:id/label` \| `/ship` \| `/receive` \| `/process` \| `/deny` | drive a return, staff only |
| `GET` | `/api/staff/conversations`, `/api/staff/conversation?customerId=` | the live takeover queue and one conversation's case file + thread, staff only |
| `POST` | `/api/staff/conversations/:customerId/take-over` | claim the thread; `409` if a colleague already holds it |
| `POST` | `/api/staff/conversations/:customerId/message` | reply as the agent on behalf of the current holder |
| `POST` | `/api/staff/conversations/:customerId/hand-back` | release the thread to the assistant; `409` if not held |
| `WS` | `/api/shop/chat/ws` \| `/api/staff/conversation/ws` | the customer's room and the staff room — notify only, bodies are re-read |

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

### A return is not a refund

The two are separate subsystems on purpose, and neither can cause the other.

A **refund** is a decision about money: the policy (or a person) decides that an
amount is owed, and the refund ledger reserves it, waits for a human to verify,
then pays it. Its state lives in `refund_requests` and `refunds`.

A **return** is a record of goods coming back: a parcel is labelled, posted,
received and processed. Its state lives in `returns` and `return_items`. It moves
no money at all — `processReturn` touches only the status, the received
quantities and product stock.

```
return_requested  ->  return_label_generated  ->  return_shipped
      |                                                   |
      |              return_denied  <--------+            |
      v                                     |            v
  (any non-terminal state)                  +----  return_received
                                                          |
                                                          v
                                                   return_processed
```

The separation is enforced rather than described:

- **Nothing on the return path writes to the refund ledger.** A return that
  reached `return_processed` has touched no refund, whatever state the customer's
  claim is in. The suite asserts the refund count is unchanged across a full
  return lifecycle.
- **`return_processed` and `return_denied` are terminal.** The goods have been
  dealt with; reopening would mean reconciling two histories by hand.
- **Lines are addressed by order line id, never product id.** An order can hold
  two lines of the same product, and a product id would file both under one key —
  which is how ticking one item returns all of them.
- **Ownership is checked before anything is read.** Order ids are sequential and
  guessable and the order id arrives in the body, so a return against someone
  else's order must be refused *before* its item names are read into a response.
- **Idempotent on the refund request.** One return per request, so a double-click
  or a retried client cannot put the same parcel in the warehouse queue twice.
- **Restocking is capped at what was received**, and resolves the product through
  the return's own line, so a typo cannot add stock for something nobody sent
  back. Stock is the one number here that stays quietly wrong until an oversell.
- **Opened against the order, not against the claim.** A return needs no refund
  request behind it — a gift return or an exchange is a parcel with no money
  attached — but when a request is supplied it is linked and used as the
  idempotency key.

The storefront does not have a returns form. The customer's route is the order
conversation, which carries the return intent, and the API is exercised by the
warehouse steps above.

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

**First question: is there a console at all.** If `ADMIN_USERNAME` and
`ADMIN_PASSWORD` are not both set, every staff route answers `404` — not `401`.
`401` would confirm that an admin area is contemplated here, and the guarantee
worth having is that an unconfigured deployment has no admin surface to find,
not merely one that rejects the credential you did not set. It holds even
against a correctly signed token, which is asserted in the suite, and the shop,
the policy and the assistant are untouched by it.

Beyond that, a staff route needs a valid credential: missing, malformed, forged
and expired ones all get `401`, and an agent credential on an admin-only route
gets `403`. Roles are `agent` (read requests, read catalogue and stats) and
`admin` (plus override). `GET /api/health`, `GET /api/policy` and the public
catalogue are unauthenticated. `GET /api/scenarios` is staff-only because the
fixtures expose internal test customers, orders, and expected decisions.
`POST /api/chat/messages` requires a signed-in shopper session; the session, not
the request body, determines the customer identity.

**How you get one.** A browser signs in at `POST /api/admin/login` with the
username and password from the environment and gets an httpOnly `SameSite=Lax`
cookie. A script mints a bearer token with the CLI. Both are the same signed
token verified against the same key, so a session has exactly the authority a
minted token does and no route is reachable one way but not the other.

The sign-in endpoint is the one this project's design would normally avoid, so
what it is *not* is the point: one account, from the environment, with no way to
create another over the network and no user table to inject into; a constant-time
comparison; one message for a wrong username and a wrong password, so it cannot
enumerate accounts; and a cookie in response, never a token in the body, so
there is no long-lived credential in JavaScript. Behind an identity provider the
whole file disappears.

Tokens are HMAC-SHA256 over `sub.role.exp`, signed with `ADMIN_API_SECRET` or
with a key derived from `ADMIN_PASSWORD`. There is no default signing key and no
dev bypass, because a default would be a way in; `ADMIN_API_SECRET` must be at
least 32 characters if supplied, and that is checked at boot rather than at the
first customer request. A missing *provider* key is deliberately not in that
list: it degrades the queue instead of stopping the service.

Sign out clears the cookie. One limitation, asserted in the suite rather than
described: the session is stateless, so a copy taken before sign out stays valid
until it expires (eight hours) or the signing key changes. That is the trade for
not keeping a second table of staff credentials.

`GET /api/admin/audit/verify` is admin-only and re-walks the audit chain on
demand, naming the id of the row that fails. It returns `200` with `ok: false`
when the chain is broken, because a broken chain is a finding to read, not a
failed request.

## Testing

```
489 passed · 8 skipped · 0 network required
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
- **Staff auth tests** — `401` for missing/malformed/forged/expired credentials,
  `403` for an agent on an admin route, and the customer chat endpoint left open.
- **Admin console tests** — the console absent without an operator account (`404`
  on every staff route, including against a correctly signed token), sign-in
  setting an httpOnly cookie with the same authority a minted token has, one
  reply for a wrong username and a wrong password, and the published demo
  password refused in production.
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
- **No simulated model in the running product.** Tests inject a fake analyzer;
  the application always talks to a real provider. What it will not do is
  substitute a pattern matcher for a model without saying so: with no key the
  provider is reported unavailable, every request that needs a claim escalates,
  and the reason is recorded in the audit trail. `AI_PROVIDER=local` selects the
  matcher explicitly, and is refused in production.
- **Degrade loudly, not silently.** A missing key is not misconfiguration to
  reject at boot; it is a product with no model. Weak secrets, invalid config and
  `AI_PROVIDER=local` under `NODE_ENV=production` still stop the process, because
  those are choices rather than absences. An empty variable counts as absent, so
  a missing key is reported as a missing key rather than as malformed optional.
  The one thing that would make a missing key invisible is a deployment paying
  for a model it never reaches, so `AI_REQUIRED` turns that into a failed boot,
  and a key is never committed to make the failure go away.
- **No secret in the repository.** `ADMIN_API_SECRET`, `ADMIN_PASSWORD` and every model key are
  supplied by the operator. `.env` is gitignored, `.env.example` documents the
  shape without values, and the compose file reads the key from the environment
  at container start rather than baking it into a layer.
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
- **The returns API has no staff UI.** The endpoints in the table above are the
  product surface for the warehouse steps; a staff page to drive them is not
  built. The routes are tested and exercised, and the reasoning above is the
  design, but the console does not yet render a returns queue.
- Single-tenant, single-currency (USD), SQLite. Not a multi-merchant ledger.

## Licence

MIT. Fictional retailer, fictional customers, fictional orders.
