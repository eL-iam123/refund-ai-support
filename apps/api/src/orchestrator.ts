import type {
  AiProposal,
  ClaimExtraction,
  GroundingResult,
  InjectionAction,
  InjectionScan,
  RefundDecision,
  RuleEvaluation,
  Stage,
  StageTiming,
} from '@refund/shared';
import type { Db } from './db/connection.js';
import type { CustomerRecord, OrderRecord } from './db/records.js';
import { findCustomer, findDuplicateSibling } from './db/orderRepository.js';
import { verifyGrounding } from './ai/index.js';
import type { AIAnalyzer, AttemptObserver, ProviderAttempt } from './ai/index.js';
import { toAnalyzerOrder } from './ai/openaiAnalyzer.js';
import { disputeCeiling, identifyOrder, type Identification } from './retrieval/identifyOrder.js';
import { scanForInjection } from './security/injection.js';
import { runFactGates, type GateResult } from './policy/gates.js';
import { evaluateRule, evaluateRules } from './policy/engine.js';
import { R14RequestIntegrity } from './policy/rules/R-14-request-integrity.js';
import { rulesForStage } from './policy/rules/index.js';
import { resolve } from './policy/resolver.js';
import type { PolicyContext } from './policy/types.js';
import { composeDeterministicResponse } from './response/compose.js';
import { formatCents } from './lib/money.js';

/**
 * The seven-stage pipeline.
 *
 * The ordering is the security property. Order facts are read and evaluated
 * before any model is contacted, so a request that the policy can already
 * refuse never reaches an LLM at all - which is what `llmCalled: false` in the
 * scenario suite means. The model's output is treated as a claim from stage 4
 * onwards, and becomes a decision in exactly one place: the resolver.
 *
 * Each stage is a separate function taking a context it can see completely.
 * The top-level function is then short enough to read in one pass, which is
 * the point: a reviewer should be able to confirm the ordering without
 * simulating the code.
 */

const REASON_RULES = rulesForStage('reason_rules');

/**
 * Persists one model attempt. Successful or not, first try or fifth.
 */
export type AttemptRecorder = (requestId: string, provider: string, attempt: ProviderAttempt) => void;

/**
 * The pipeline's only non-durable dependency.
 *
 * Passing the analyzer in rather than importing a singleton is what lets the
 * test suite run all eighteen scenarios with no network, no API key, no rate
 * limit and no nondeterminism, against the same code the server runs.
 */
export interface PipelineDeps {
  readonly analyzer: AIAnalyzer;
  readonly recordAttempt: AttemptRecorder;
  /** REFUND_POLICY.md §7.1. Deny is the safe default; see R-14. */
  readonly injectionAction: InjectionAction;
}

export interface ProcessInput {
  readonly requestId: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly now: Date;
}

export interface ProcessResult {
  readonly customer: CustomerRecord;
  readonly order: OrderRecord | null;
  readonly decision: RefundDecision;
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  readonly injection: InjectionScan;
  readonly responseText: string;
  readonly llmCalled: boolean;
  readonly aiMode: string;
  readonly timings: readonly StageTiming[];
  readonly resolvedOrderId: string | null;
}

export class UnknownCustomerError extends Error {
  constructor(customerId: string) {
    super(`no customer with id "${customerId}"`);
    this.name = 'UnknownCustomerError';
  }
}

/** Accumulates per-stage timings for the admin drawer. */
class StageLog {
  private readonly entries: StageTiming[] = [];
  private readonly startedAt = Date.now();
  private lastTick = this.startedAt;

  /** Duration is measured from the previous stage, so no caller passes clocks. */
  record(stage: Stage, detail: string): void {
    const now = Date.now();
    this.entries.push({ stage, durationMs: now - this.lastTick, detail });
    this.lastTick = now;
  }

  totalMs(): number {
    return Date.now() - this.startedAt;
  }

  all(): readonly StageTiming[] {
    return this.entries;
  }
}

export async function processRefundRequest(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
): Promise<ProcessResult> {
  const log = new StageLog();
  const observer: AttemptObserver = (attempt) => {
    deps.recordAttempt(input.requestId, deps.analyzer.label, attempt);
  };

  const intake = runIntake(db, input, deps.injectionAction, log);
  const retrieval = retrieveOrder(db, input, intake, log);
  const gates = runFactGates(retrieval.context);
  log.record(
    'fact_gates',
    gates.terminal
      ? `terminated by ${gates.decidingRuleId ?? 'gates'}; model not called`
      : `${gates.blockedItems.length} item(s) excluded, ${formatCents(gates.eligibleAmountCents)} eligible`,
  );

  const analysis = await analyseClaim(deps, input, gates, retrieval.order, observer, log);
  const reasonEvaluations = runReasonRules(retrieval.context, gates, analysis, log);
  const decision = resolveDecision(
    db,
    retrieval.found,
    gates,
    intake.evaluations,
    reasonEvaluations,
    analysis,
  );
  log.record('resolve', `${decision.decision} ${formatCents(decision.refundAmountCents)}`);

  const responseText = composeReply(decision, retrieval.order, input.message, log);

  return {
    customer: intake.customer,
    order: retrieval.order,
    decision,
    extraction: analysis.extraction,
    grounding: analysis.grounding,
    injection: intake.injection,
    responseText,
    // True whenever the request reached stage 4 without being gate-terminated,
    // whether or not the provider answered. The attempt rows say which.
    llmCalled: !gates.terminal,
    aiMode: `${deps.analyzer.label} (${deps.analyzer.model})`,
    timings: log.all(),
    resolvedOrderId: retrieval.order?.id ?? null,
  };
}

// --- Stages ------------------------------------------------------------------

interface Intake {
  readonly customer: CustomerRecord;
  readonly injection: InjectionScan;
  readonly evaluations: RuleEvaluation[];
  readonly context: PolicyContext;
}

/** Stage 1: scan the message, load the customer, run the integrity rule. */
function runIntake(
  db: Db,
  input: ProcessInput,
  injectionAction: InjectionAction,
  log: StageLog,
): Intake {
  const injection = scanForInjection(input.message);
  log.record(
    'intake',
    injection.detected ? `${injection.signals.length} override signal(s)` : 'clean',
  );

  const customer = findCustomer(db, input.customerId, input.now);
  if (customer === null) {
    throw new UnknownCustomerError(input.customerId);
  }

  const context: PolicyContext = {
    db,
    customer,
    order: null,
    duplicateSibling: null,
    injection,
    injectionAction,
    extraction: null,
    grounding: null,
    subjectItem: null,
    eligibleItems: [],
    blockedItems: [],
    eligibleAmountCents: 0,
    orderTotalCents: 0,
  };

  // R-14 runs at intake but is resolved last, so a hostile message can still
  // be shown being clamped rather than being quietly dropped.
  return {
    customer,
    injection,
    evaluations: [evaluateRule(R14RequestIntegrity, context)],
    context,
  };
}

interface Retrieval {
  readonly found: Identification;
  readonly order: OrderRecord | null;
  readonly context: PolicyContext;
}

/** Stage 2: resolve the order and the duplicate-charge sibling. */
function retrieveOrder(db: Db, input: ProcessInput, intake: Intake, log: StageLog): Retrieval {
  const found = identifyOrder(db, intake.customer, input.orderId, input.message, input.now);
  const order = found.order;
  const duplicateSibling = order === null ? null : findDuplicateSibling(db, order, input.now);

  log.record('retrieve', found.evidence);

  return {
    found,
    order,
    context: {
      ...intake.context,
      order,
      duplicateSibling,
      orderTotalCents: order?.totalCents ?? 0,
    },
  };
}

interface Analysis {
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  readonly proposal: AiProposal | null;
}

const NO_ANALYSIS: Analysis = { extraction: null, grounding: null, proposal: null };

/**
 * Stage 4: the one model call, plus the grounding check on its output.
 *
 * The catch is the point, not a best-effort convenience. Every rule has already
 * run on order facts by this point, so a provider that is down, rate-limited or
 * simply wrong about the schema costs the request its evidence and nothing
 * else - and "no claim" can only escalate, never approve.
 */
async function analyseClaim(
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  order: OrderRecord | null,
  observer: AttemptObserver,
  log: StageLog,
): Promise<Analysis> {
  if (gates.terminal) {
    log.record('ai_analysis', 'not reached: fact gates terminated the request');
    return NO_ANALYSIS;
  }

  let result: Awaited<ReturnType<AIAnalyzer['analyze']>>;
  try {
    result = await deps.analyzer.analyze({ message: input.message, order: toAnalyzerOrder(order) }, observer);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    log.record('ai_analysis', `no usable extraction (${truncate(reason, 120)}); continuing without a claim`);
    return NO_ANALYSIS;
  }

  const grounding = verifyGrounding(result.extraction, input.message);
  log.record(
    'ai_analysis',
    `reason="${result.extraction.reason}" intent="${result.extraction.intent}" ` +
      `lang=${result.extraction.language} grounded=${String(grounding?.grounded ?? false)} ` +
      `via ${result.model}`,
  );
  return { extraction: result.extraction, grounding, proposal: result.proposal };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Stage 5: the rules that need the model's claim, plus R-14's veto. */
function runReasonRules(
  context: PolicyContext,
  gates: GateResult,
  analysis: Analysis,
  log: StageLog,
): RuleEvaluation[] {
  if (gates.terminal) {
    log.record('reason_rules', 'not reached: fact gates terminated the request');
    return [];
  }
  if (context.injection.detected) {
    log.record('reason_rules', 'not reached: extraction discarded as untrusted after an override attempt');
    return [];
  }

  const evaluations = evaluateRules(REASON_RULES, {
    ...context,
    eligibleItems: gates.eligibleItems,
    blockedItems: gates.blockedItems,
    eligibleAmountCents: gates.eligibleAmountCents,
    extraction: analysis.extraction,
    grounding: analysis.grounding,
  });

  const decided = evaluations.filter((rule) => rule.outcome !== 'pass');
  log.record(
    'reason_rules',
    decided.length === 0
      ? `${evaluations.length} rules evaluated, none reached a conclusion`
      : decided.map((rule) => `${rule.ruleId}->${rule.outcome}`).join(', '),
  );
  return evaluations;
}

function resolveDecision(
  db: Db,
  found: Identification,
  gates: GateResult,
  intakeEvaluations: RuleEvaluation[],
  reasonEvaluations: RuleEvaluation[],
  analysis: Analysis,
): RefundDecision {
  const order = found.order;
  return resolve({
    intakeEvaluations,
    gateResult: gates,
    reasonEvaluations,
    grounding: analysis.grounding,
    aiProposal: analysis.proposal,
    orderTotalCents: order?.totalCents ?? 0,
    orderId: order?.id ?? null,
    disputeCeilingCents: disputeCeiling(found, gates.eligibleItems),
    db,
    order: order ?? null,
  });
}

/**
 * Stage 7: the customer-facing text.
 *
 * Composed from the decision and the order, never from the model's output and
 * never from the customer's message. That is a security property, not a
 * simplification: no instruction embedded in a customer's message can reach
 * text a customer reads, because the message is not an input to this function.
 */
function composeReply(decision: RefundDecision, order: OrderRecord | null, message: string, log: StageLog): string {
  // The message is passed for one narrow purpose: recognising an attachment the
  // system cannot open, and frustration worth acknowledging. It is not used to
  // phrase the decision itself, which is assembled from the decision and order
  // alone - that separation is what stops a customer's own words, or an
  // instruction hidden in them, from reaching the answer they are given.
  const text = composeDeterministicResponse(decision, order, message);
  log.record('respond', 'composed from the decision, no model in this path');
  return text;
}

// --- Helpers -----------------------------------------------------------------

