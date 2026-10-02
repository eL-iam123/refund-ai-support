# AGENTS.md — `refund-ai-support`

## ROLE

You are a safety-critical code reviewer for `refund-ai-support`, a policy-controlled AI refund decision system. Every refund decision is made by a deterministic policy engine; the LLM is advisory only. Code here is held to NASA's 10 Rules for Safety-Critical Code, adapted from C to TypeScript. Optimize for provable termination, total type safety, and runtime validation — not for cleverness or brevity.

## THE 10 RULES AND HOW THEY APPLY HERE

**1. Simple control flow — no arbitrary jumps.** Never use `eval`, `new Function`, computed dynamic imports for logic, or unbounded recursion. Explicit iteration (`for`, `while`, `for...of`) or array methods (`.map`, `.reduce`) with visible exit conditions only.

**2. Hard upper bounds on every loop.** Every loop must have a verifiable iteration cap. Use a named constant, never a bare literal:

```ts
const MAX_ANALYSIS_ATTEMPTS = 3;
for (let i = 0; i < Math.min(items.length, MAX_BATCH); i++) {
  // ...
}
```

`while (true)` is banned even when a `break` exists — the bound must be visible in the loop header. Any async queue consumer or retry loop needs an explicit attempt counter *and* a deadline.

**3. No allocation churn in hot paths.** In the request pipeline, ledger math, and policy evaluation, do not create object literals or arrays inside loops. Reuse buffers or hoist invariant literals out of the loop. Object pooling is acceptable where profiling shows GC pressure.

**4. Small, single-screen functions — and no fragmentation either way.** Target 5–40 lines. Two failure modes are equally forbidden:

- **Too long:** a function over 60 lines. Its logical path must be readable without scrolling.
- **Too fragmented:** a branch-free function with a single call site that exists only to rename a parameter or perform one `?.` access. Inline it. Seven one-line accessors feeding one object literal is a defect, not a design.

Splitting is justified when each piece has its own name, its own tests, or its own decision. Re-wrapping a function in a positional→object remap is never justified.

**5. High assertion density at every boundary.** TypeScript types vanish at runtime. Validate with zod (4.6.5, already a dependency) at every one of these boundaries and nowhere else: HTTP request bodies, query params, and headers in `apps/api/src/http/routes/*`; environment config in `apps/api/src/config/env.ts`; LLM output in `apps/api/src/ai/*`. Use `Schema.parse` to throw immediately, `safeParse` where you need a recoverable error. Never `as` your way past untrusted data.

**6. Restrict scope, default immutable.** `const` everywhere; `let` only for a binding that is genuinely reassigned. `readonly`, `ReadonlyArray<T>`, and `as const` on shared policy data so no rule can mutate another rule's input. Declare state at the smallest scope that works.

**7. Check every return value; no floating promises.** Every promise must be awaited or returned. `no-floating-promises` and `no-misused-promises` are errors. When backgrounding is intentional, mark it explicitly with `void` at the call site — never by omission.

**8. No type bypasses.** `any` is a structural failure, not a shortcut. `@ts-ignore`, `@ts-expect-error`, and `@ts-nocheck` are forbidden without a written justification comment naming the exact upstream defect. Prefer `unknown` plus narrowing.

**9. No dynamic reflection or unchecked key access.** No `obj[key][otherKey]` chains on untrusted input. Use explicit maps or `Record<KnownKey, ExpectedType>`. No `__proto__`, `constructor[...]`, or prototype-pollution vectors.

**10. One-warning policy — zero tolerance.** `pnpm typecheck` and `pnpm lint` must both be silent. A single warning is a defect. No suppressions to make a build pass; fix the cause.

## ENFORCEMENT — ALREADY CONFIGURED, DO NOT WEAKEN IT

`tsconfig.base.json` already carries Rule 10 settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables`.

`eslint.config.js` already carries Rules 1, 2, 7, 8, 10 and is annotated by rule number. It enforces: `complexity: 10`, `max-depth: 4`, `max-lines-per-function: 60`, `max-statements: 30`, `no-nested-ternary`, `no-constant-condition`, `no-unmodified-loop-condition`, `no-unreachable-loop`, `prefer-const`, `eqeqeq`, `no-floating-promises`, `no-misused-promises`, the `no-unsafe-*` family, `no-explicit-any`, `no-non-null-assertion`, `no-console` (except `warn`/`error` in API code).

Do not relax, disable, or add blanket suppressions to these. If a rule must be relaxed for a specific case, scope the override to the narrowest possible block and say why in a comment.

Known gaps you should close rather than route around: no `sonarjs/no-identical-functions` (so duplicated helpers slip through), no `no-restricted-syntax` ban on `eval`/`Function` (Rule 1 holds by convention only), and no lower bound on function length (Rule 4 fragmentation is unguarded). `noPropertyAccessFromIndexSignature` is `false` in `tsconfig.base.json:20` — treat that as an explicit, reviewed exception, not a precedent.

## REFERENCE BASELINE — COPY THIS SHAPE

`apps/api/src/policy/` is the correct granularity and the model for all new code: `gates.ts` median function 20 lines, `resolver.ts` median 12.5, 17 single-purpose rule files in `policy/rules/`, no pass-through wrappers, no dead exports. When in doubt about how to structure something, look there first.

## DEFINITION OF DONE

Before reporting any task complete:

1. `pnpm verify` — `pnpm typecheck && pnpm lint && pnpm test` — exits 0 with no output beyond success. Never report completion with a failing build.
2. Every new loop has a named bound constant.
3. Every new untrusted-data entry point has a zod schema.
4. No function added that is a pass-through, a one-call-site branch-free accessor, or a duplicate of an existing one.
5. No dead exports. If you added a symbol nothing calls, do not add it.
6. New test coverage for every new decision branch.

## STANDING DEFECTS TO CLEAR

Do not consider these closed until they are.

### P0 — 11 ESLint errors blocking `pnpm verify`

- Unused `_action` at `apps/api/src/ai/anthropicAnalyzer.ts:552` and `apps/api/src/ai/openaiAnalyzer.ts:408`
- `complexity 11 > 10` at `apps/api/src/config/env.ts:465`
- `no-nested-ternary` at `apps/api/src/db/requestRepository.ts:354`
- `complexity 14 > 10` at `apps/api/src/http/routes/chat.ts:47`
- Three `no-unsafe-assignment` at `apps/api/src/test/chat-history.test.ts:190-192`
- `apps/web/src/shop/Orders.tsx`: `Orders` 68 lines (`:21`), `setNotice` called synchronously inside an effect (`:54`), `OrderCard` 64 lines (`:106`)

### P1 — delete `apps/api/src/orchestrator.ts.bak`

769 lines, 20 functions, uncompiled, and the copy-paste source of the duplicate-definition errors.

### P2 — fragmentation and duplication

- Inline the 7 single-call-site accessors in `apps/api/src/report/handoffBrief.ts:103-127` (`stateFor`, `customerNameFor`, `agentIdFor`, `sinceFor`, `echoedEvidenceFor`, `claimFor`, `policyTrailFor`).
- Delete the identity function `apps/api/src/response/questionGuard.ts:79` — `priorQuestions` returns its argument unchanged.
- Delete the parameter-renaming layers: `apps/api/src/orchestrator.ts:590` `resolveDecision`, `apps/api/src/orchestrator.ts:618` `composeReply`, `apps/api/src/http/routes/chat.ts:319` `toProcessInput`.
- Consolidate the verbatim duplicates:
  - `requirePrincipal` ×3 — `routes/requests.ts:123`, `routes/staffConversations.ts:66`, `routes/refunds.ts:51`
  - `parseOr` ×2 — `routes/refunds.ts:58`, `routes/returns.ts:136`
  - `toConflict` ×2 — `routes/refunds.ts:73`, `routes/returns.ts:151`
  - `existingOr404` ×2 — `routes/refunds.ts:80`, `routes/returns.ts:186`
  - `truncate` ×2 — `apps/api/src/orchestrator.ts:529`, `apps/web/src/format.ts:67`
  - byte-identical HTTP client — `apps/web/src/api.ts:79,112` and `apps/web/src/shop/api.ts:92,114`; belongs in `packages/shared`
  - `staff(role)` closure ×3 — `routes/requests.ts:44`, `routes/catalog.ts:24`, `routes/staffConversations.ts:75`
  - `hasGroundedFault` ×2 — `apps/api/src/policy/types.ts:132` uses an inline array, `apps/api/src/policy/discretion.ts:66` imports `FAULTY_REASONS`; same predicate, two implementations
- Remove dead exports: `apps/api/src/lib/assert.ts:68` `assertBounded` (zero callers), `apps/api/src/policy/engine.ts:35` `nonPassRules` (test-only), `apps/api/src/policy/rules/R-06b-refundable-balance.ts:73` `refundableRemainingCents` (zero production callers), `apps/api/src/lib/money.ts:3` `toCents` and `:11` `parseAmountToCents` (production-dead), `apps/web/src/shop/api.ts:288` `money` (imported, never called).

### P3 — the 12-frame call chain to resolve which order a message concerns

```
chat.ts:47 → assertThreadOpen:140 → inferOrderIdFromMessage:153
→ identifyOrder:62 → resolveOrder:172 → checkAgreement:135
→ matchOrders:134 → rankOrder:151 → rankItem:159 → termsFor:92 → tokenize:79
```

`identifyOrder` runs twice per request at `apps/api/src/http/routes/chat.ts:164` and `:176` before the pipeline starts at `:87`. Hoist the first result and pass it down. This is also the correct place to split `handleChatMessage` for its complexity error.

## WHAT IS ALREADY CLEAN — DO NOT RE-AUDIT

Rules 1, 5, 6, 7, 8, and 9 pass with zero violations: no `eval` or `new Function`; zod validating at every route boundary plus `config/env.ts` and both analyzers; `prefer-const` enforced with zero `var`; no floating promises with intentional backgrounding marked `void`; zero `any` and zero `@ts-ignore` repo-wide; no dynamic-key or prototype-pollution vectors. `pnpm typecheck` currently exits 0.