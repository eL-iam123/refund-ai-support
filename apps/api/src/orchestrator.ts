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
import type { AIAnalyzer, AttemptObserver, DialogueLine, ProviderAttempt } from './ai/index.js';
import { toAnalyzerOrder } from './ai/openaiAnalyzer.js';
import { disputeCeiling, identifyOrder, type Identification } from './retrieval/identifyOrder.js';
import { scanForInjection } from './security/injection.js';
import { transcriptForOrder } from './retrieval/conversation.js';
import { adoptDialogueToOrder } from './db/dialogue.js';
import { runFactGates, type GateResult } from './policy/gates.js';
import { evaluateRule, evaluateRules } from './policy/engine.js';
import { R14RequestIntegrity } from './policy/rules/R-14-request-integrity.js';
import { rulesForStage } from './policy/rules/index.js';
import { resolve } from './policy/resolver.js';
import type { PolicyContext } from './policy/types.js';
import { composeDeterministicResponse } from './response/compose.js';
import { isNoComplaint, noComplaintQuestion, NO_COMPLAINT_MODEL } from './response/noComplaint.js';
import { clarifySparseDamage } from './response/claimClarification.js';
import { assistantLines, refineQuestion } from './response/questionGuard.js';
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
 * There is one deliberate exception to that ordering, and it is the point
 * between retrieval and the fact gates. When no order could be resolved, the
 * assistant is allowed to ask the customer to clarify *which* order before the
 * policy runs - because with no order there is nothing for the policy to run
 * on, and the alternative to a question is an escalation for what is usually a
 * missing order reference. The ask only happens under conditions that make it
 * safe (a real analyzer to continue the conversation, no injection attempt, at
 * least one order to clarify against), and it produces no decision and no
 * request row - just one stored question.
 *
 * Each stage is a separate function taking a context it can see completely.
 * The top-level function is then short enough to read in one pass, which is
 * the point: a reviewer should be able to confirm the ordering without
 * simulating the code.
 */

const REASON_RULES = rulesForStage('reason_rules');
/** How much of the prior conversation is shipped to the model with each turn. */
const HISTORY_LIMIT = 12;

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
  /**
   * Order lines the customer ticked in the storefront's picker, by id.
   *
   * Narrows the claim and never widens it: every id is checked against the
   * resolved order during retrieval, and one that belongs to no line of it is
   * dropped rather than resolved elsewhere. Empty - the ordinary case - leaves
   * item identification entirely to the deterministic keyword matcher.
   */
  readonly itemIds: readonly string[];
  readonly now: Date;
}

/**
 * What running the pipeline produced.
 *
 * Two outputs, and the caller cannot confuse them because they are different
 * types. An `asked` result is the assistant choosing to clarify: nothing was
 * decided, so nothing may be persisted as a decision - the caller stores the
 * question instead. A `decided` result is the resolver's decision, which the
 * caller persists as a request row. The discriminator makes "a question is not
 * a decision" a compile-time property of every caller, not a comment.
 */
export type ProcessResult =
  | {
      readonly stage: 'asked';
      readonly question: string;
      readonly customer: CustomerRecord;
      readonly order: OrderRecord | null;
      readonly resolvedOrderId: string | null;
      readonly injection: InjectionScan;
      readonly llmCalled: boolean;
      readonly aiMode: string;
      readonly timings: readonly StageTiming[];
    }
  | {
      readonly stage: 'decided';
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
    };

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

  // The clarify turn, before the fact gates. Its guards are its whole safety:
  // unresolved order, a real analyzer to continue the conversation, no
  // injection attempt, and at least one order to clarify against. Without all
  // four the request proceeds into the pipeline and escalates exactly as
  // before, so the question cannot widen what the policy would decide.
  const mode = `${deps.analyzer.label} (${deps.analyzer.model})`;
  const clarification = clarifyOrder(retrieval.found, deps.analyzer, intake.injection, log);
  if (clarification !== null) {
    return askedResult(clarification, retrieval.order, intake, false, mode, log);
  }

  const gates = runFactGates(retrieval.context);
  log.record(
    'fact_gates',
    gates.terminal
      ? `terminated by ${gates.decidingRuleId ?? 'gates'}; model not called`
      : `${gates.blockedItems.length} item(s) excluded, ${formatCents(gates.eligibleAmountCents)} eligible`,
  );

  const analysis = await analyseRequest(db, deps, input, gates, retrieval, intake, observer, log);
  if (analysis.outcome === 'question') {
    return askedResult(analysis.question, retrieval.order, intake, true, mode, log);
  }

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

  // An unresolved-order question was answered; its dialogue belongs to the
  // order it resolved to. Adoption is a display-and-context concern only - the
  // decision above is what it is either way.
  if (retrieval.order !== null) {
    adoptDialogueToOrder(db, input.customerId, retrieval.order.id);
  }

  return {
    stage: 'decided',
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
    aiMode: mode,
    timings: log.all(),
    resolvedOrderId: retrieval.order?.id ?? null,
  };
}

function analyseRequest(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  intake: Intake,
  observer: AttemptObserver,
  log: StageLog,
): Promise<AnalyseOutcome> {
  return analyseClaim(
    db,
    deps,
    input,
    gates,
    retrieval.order,
    intake.injection.detected,
    observer,
    log,
  );
}

/**
 * The asked branch of the pipeline, built in one place so the two question
 * exits - OrderRetrieval's deterministic clarify, and the model's own ask -
 * cannot drift apart.
 */
function askedResult(
  question: string,
  order: OrderRecord | null,
  intake: Intake,
  llmCalled: boolean,
  aiMode: string,
  log: StageLog,
): Extract<ProcessResult, { stage: 'asked' }> {
  return {
    stage: 'asked',
    question,
    customer: intake.customer,
    order,
    resolvedOrderId: order?.id ?? null,
    injection: intake.injection,
    llmCalled,
    aiMode,
    timings: log.all(),
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
  const found = identifyOrder(db, intake.customer, input.orderId, input.message, input.now, input.itemIds);
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

/**
 * The one question the pipeline asks without the model: "which order?".
 *
 * Between retrieval and the fact gates, because an unresolved order leaves the
 * fact gates nothing to run on. Every guard here is load-bearing and each one
 * answers a way this could go wrong:
 *
 *  - `unresolved` only - a resolved order proceeds to the model, which may ask
 *    its own question in its own words.
 *  - `available` - the question is only worth asking if a model will be there
 *    to read the customer's answer. Without one, asking just delays the
 *    escalation by a round trip.
 *  - no injection attempt - a hostile message gets the safe path (R-14, a
 *    person) instead of a friendly conversation.
 *  - at least one candidate - a customer with no orders on file has nothing to
 *    clarify; the question would be nonsense and the escalation is correct.
 *
 * Returns null (proceed) rather than throwing, so the ordinary pipeline shape -
 * everything terminal escalates - is untouched.
 */
function clarifyOrder(
  found: Identification,
  analyzer: AIAnalyzer,
  injection: InjectionScan,
  log: StageLog,
): string | null {
  // Two or more of the customer's own orders stand behind the ambiguity: this
  // is "which order do you mean?", a question only the customer can answer. A
  // single unresolved reference - a typo, or an id that belongs to nobody on
  // this account - is deliberately NOT asked about: probing an id must not be
  // answered with a confirmation that it does or does not exist, so that case
  // keeps the R-13 escalation a person reviews. Injection attempts and a
  // missing model are likewise not conversable, and proceed to the pipeline.
  if (found.basis !== 'unresolved' || !analyzer.available || injection.detected || found.candidates < 2) {
    return null;
  }
  const question = `I could not tell which order that is about - I can see ${found.candidates} recent orders on your account. Could you send the order number (something like ORD-1234) or the name of the product it concerns?`;
  log.record('ai_analysis', 'not reached: asked the customer to clarify which order');
  return question;
}

interface Analysis {
  readonly extraction: ClaimExtraction | null;
  readonly grounding: GroundingResult | null;
  readonly proposal: AiProposal | null;
}

type AnalyseOutcome =
  | ({ readonly outcome: 'claim' } & Analysis)
  | { readonly outcome: 'question'; readonly question: string; readonly model: string };

const NO_ANALYSIS: AnalyseOutcome = {
  outcome: 'claim',
  extraction: null,
  grounding: null,
  proposal: null,
};

/**
 * Stage 4: the one model call, plus the grounding check on its output.
 *
 * The model may answer with a question or with a claim; either is a valid
 * reply and both are real behaviours of a messenger. A question flows straight
 * out as the `asked` result - nothing was decided, so nothing is handed to the
 * resolver. A claim gets grounded against the full customer corpus: the current
 * message and every earlier message of theirs, so the model is permitted to
 * quote an earlier turn and the check still catches a quote from anywhere else.
 *
 * The catch is the point, not a best-effort convenience. Every rule has already
 * run on order facts by this point, so a provider that is down, rate-limited or
 * simply wrong about the schema costs the request its evidence and nothing
 * else - and "no claim" can only escalate, never approve.
 */
async function analyseClaim(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  order: OrderRecord | null,
  injectionDetected: boolean,
  observer: AttemptObserver,
  log: StageLog,
): Promise<AnalyseOutcome> {
  if (gates.terminal) {
    log.record('ai_analysis', 'not reached: fact gates terminated the request');
    return NO_ANALYSIS;
  }

  const history = transcriptForOrder(db, input.customerId, orderIdFor(order), input.now, HISTORY_LIMIT);

  const damageClarification = clarifyDamageReport(input.message, order, history, log);
  if (damageClarification !== null) {
    return damageClarification;
  }

  const noComplaint = clarifyNoComplaint(input.message, order, history, log);
  if (noComplaint !== null) {
    return noComplaint;
  }

  let reply: Awaited<ReturnType<AIAnalyzer['analyze']>>;
  try {
    reply = await deps.analyzer.analyze(
      { message: input.message, order: toAnalyzerOrder(order), history },
      observer,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    log.record('ai_analysis', `no usable extraction (${truncate(reason, 120)}); continuing without a claim`);
    return { outcome: 'claim', extraction: null, grounding: null, proposal: null };
  }

  if (reply.kind === 'question') {
    // A flagged message cannot leave through the question branch: doing so
    // would let model-authored text bypass R-14's denial/escalation entirely.
    // Discard the model response and continue with no claim so the resolver
    // records the configured integrity outcome.
    if (injectionDetected) {
      log.record('ai_analysis', 'discarded model question after an injection signal');
      return NO_ANALYSIS;
    }
    return respondToQuestion(reply, order, history, log);
  }

  // Only the customer's side of the transcript is eligible evidence. The model
  // may quote something the customer said two messages ago, but never its own
  // question and never its own phrasing.
  const corpus = [...history.filter((line) => line.role === 'customer').map((line) => line.text), input.message];
  const grounding = verifyGrounding(reply.extraction, corpus);
  log.record(
    'ai_analysis',
    `reason="${reply.extraction.reason}" intent="${reply.extraction.intent}" ` +
      `lang=${reply.extraction.language} grounded=${groundedLabel(grounding)} ` +
      `via ${reply.model}`,
  );
  return {
    outcome: 'claim',
    extraction: reply.extraction,
    grounding,
    proposal: reply.proposal,
  };
}

/** Keep a damage report without observed condition out of policy analysis. */
function clarifyDamageReport(
  message: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  log: StageLog,
): AnalyseOutcome | null {
  const question = clarifySparseDamage(message);
  if (question === null) {
    return null;
  }
  log.record('ai_analysis', 'sparse damage report; asked for the observed condition before claim analysis');
  return respondToQuestion(
    { kind: 'question', question, model: 'deterministic-damage-clarification-v1' },
    order,
    history,
    log,
  );
}

/** Keep greetings and social-only turns out of claim analysis. */
function clarifyNoComplaint(
  message: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  log: StageLog,
): AnalyseOutcome | null {
  if (!isNoComplaint(message)) {
    return null;
  }
  log.record('ai_analysis', 'no complaint in the message; answered from the deterministic floor');
  return respondToQuestion(
    { kind: 'question', question: noComplaintQuestion(message, order !== null), model: NO_COMPLAINT_MODEL },
    order,
    history,
    log,
  );
}

/**
 * The deterministic floor under the messenger's questions.
 *
 * The prompt tells the model never to open with a greeting, never to demand an
 * order number the pipeline has resolved, and never to repeat itself; the guard
 * makes those rules hold when the model ignores them. A canned question is
 * replaced with a warm restatement, a repeat hands the thread to a person, and
 * only a real question reaches the customer.
 */
function respondToQuestion(
  reply: Awaited<ReturnType<AIAnalyzer['analyze']>> & { readonly kind: 'question' },
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  log: StageLog,
): AnalyseOutcome {
  const refined = refineQuestion(reply.question, {
    orderResolved: order !== null,
    priorAssistantText: assistantLines(history),
  });
  if (refined.kind === 'escalate') {
    log.record('ai_analysis', 'asked a question already asked; escalating to a person');
    return NO_ANALYSIS;
  }
  const question = refined.kind === 'replace' ? refined.question : reply.question;
  log.record(
    'ai_analysis',
    refined.kind === 'replace'
      ? `replaced a canned question with a warm restatement (${reply.model})`
      : `asked the customer the missing detail (${reply.model})`,
  );
  return { outcome: 'question', question, model: reply.model };
}

function orderIdFor(order: OrderRecord | null): string | null {
  return order?.id ?? null;
}

function groundedLabel(grounding: GroundingResult | null): string {
  return String(grounding?.grounded ?? false);
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

