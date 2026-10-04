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
import type { IntakeReply } from './ai/analyzer.js';
import { DEFAULT_ITEM_PICKER, itemPickerOffer, reportedItemIds, type ItemPickerOffer } from './retrieval/itemPicker.js';
import type { Db } from './db/connection.js';
import type { CustomerRecord, OrderRecord } from './db/records.js';
import type { DiscretionConfig, ItemPickerConfig } from './config/env.js';
import { findCustomer, findDuplicateSibling } from './db/orderRepository.js';
import { verifyGrounding } from './ai/index.js';
import type { AIAnalyzer, AttemptObserver, DialogueLine, ProviderAttempt } from './ai/index.js';
import { toAnalyzerOrder } from './ai/openaiAnalyzer.js';
import { disputeCeiling, identifyOrder, type Identification } from './retrieval/identifyOrder.js';
import { scanForInjection } from './security/injection.js';
import { transcriptForOrder } from './retrieval/conversation.js';
import { adoptDialogueToOrder } from './db/dialogue.js';
import { activeHandoffForCustomer } from './db/handoffs.js';
import { runFactGates, type GateResult } from './policy/gates.js';
import { evaluateRule, evaluateRules } from './policy/engine.js';
import { DEFAULT_DISCRETION } from './policy/discretion.js';
import { R14RequestIntegrity } from './policy/rules/R-14-request-integrity.js';
import { rulesForStage } from './policy/rules/index.js';
import { resolve } from './policy/resolver.js';
import type { PolicyContext } from './policy/types.js';
import { composeDeterministicResponse } from './response/compose.js';
import { isNoComplaint, noComplaintQuestion, NO_COMPLAINT_MODEL } from './response/noComplaint.js';
import { clarifySparseDamage } from './response/claimClarification.js';
import { assistantLines, refineQuestion } from './response/questionGuard.js';
import { nextMissingField, questionForField, type NextQuestionInput } from './response/nextQuestion.js';
import { acknowledgementFor } from './response/acknowledge.js';
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
const HISTORY_LIMIT = 12;

export type AttemptRecorder = (requestId: string, provider: string, attempt: ProviderAttempt) => void;

export interface PipelineDeps {
  readonly analyzer: AIAnalyzer;
  readonly recordAttempt: AttemptRecorder;
  readonly injectionAction: InjectionAction;
  /**
   * The operator's pre-authorised discretion bounds.
   *
   * Optional so a caller that has no opinion about discretion gets
   * `DEFAULT_DISCRETION`, which has the layer switched off. That default is the
   * safe one: an escalation with no bounds supplied still escalates, so omitting
   * this can never widen what is paid.
   */
  readonly discretion?: DiscretionConfig;
  /**
   * When to offer the item picker inside the conversation.
   *
   * Optional, defaulting to `DEFAULT_ITEM_PICKER`. Unlike discretion the default
   * is *on*, because the picker cannot move money: it can only ask, and only the
   * customer's click supplies the scope. Omitting it therefore cannot widen a
   * claim - at worst the customer is asked a question they can decline.
   */
  readonly itemPicker?: ItemPickerConfig;
  /**
   * The lowest claim confidence the engine will act on without asking a person.
   *
   * Optional, defaulting to the `AI_MIN_CONFIDENCE` schema default, so a caller that
   * has no opinion gets the production behaviour rather than something invented for a
   * test. It can only ever escalate: the floor decides whether a *paid* decision is
   * allowed, never whether a refusal is.
   */
  readonly minConfidence?: number;
  /**
   * Tell the customer something, mid-request.
   *
   * Used once: to say "I could not read that, trying once more" before the soft
   * retry, so the retry is visible rather than a silent pause. Optional because a
   * caller with no socket - a seed run, a script - simply has nowhere to publish,
   * and the ladder must not depend on being watched.
   */
  readonly notifyCustomer?: (customerId: string) => void;
}

export interface ProcessInput {
  readonly requestId: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly itemIds: readonly string[];
  readonly now: Date;
}

export type ProcessResult =
  | {
      readonly stage: 'asked';
      readonly question: string;
      /** The item picker to render instead of a sentence, when one was offered. */
      readonly picker: ItemPickerOffer | null;
      /** What the ladder had to do, for the customer. Null when nothing happened. */
      readonly notice: string | null;
      readonly customer: CustomerRecord;
      readonly order: OrderRecord | null;
      readonly resolvedOrderId: string | null;
      readonly itemIds: readonly string[];
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
      /** What the ladder had to do, for the customer. Null when nothing happened. */
      readonly notice: string | null;
      readonly itemIds: readonly string[];
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

class StageLog {
  private readonly entries: StageTiming[] = [];
  private readonly startedAt = Date.now();
  private lastTick = this.startedAt;

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

/**
 * The sink for every provider attempt.
 *
 * Its own function because it closes over two things, and a closure built inline in the
 * middle of a pipeline stage is the sort of thing that ends up recording the wrong
 * request id once someone adds a second one.
 */
function attemptObserver(deps: PipelineDeps, requestId: string): AttemptObserver {
  return (attempt) => {
    deps.recordAttempt(requestId, deps.analyzer.label, attempt);
  };
}

export async function processRefundRequest(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
): Promise<ProcessResult> {
  const log = new StageLog();
  const observer = attemptObserver(deps, input.requestId);

  const intake = runIntake(db, input, deps.injectionAction, log);
  const retrieval = retrieveOrder(db, input, intake, log);

  if (retrieval.order !== null) {
    adoptDialogueToOrder(db, input.customerId, retrieval.order.id);
  }

  const mode = `${deps.analyzer.label} (${deps.analyzer.model})`;
  const clarification = clarifyOrder(retrieval.found, deps.analyzer, intake.injection, log);
  if (clarification !== null) {
    return askedResult(clarification, retrieval.order, retrieval.found.items.map((item) => item.id), intake, false, mode, log);
  }

  const gates = runFactGates(
    retrieval.context,
    input.itemIds,
  );
  log.record(
    'fact_gates',
    gates.terminal
      ? `terminated by ${gates.decidingRuleId ?? 'gates'}; model not called`
      : `${gates.blockedItems.length} item(s) excluded, ${formatCents(gates.eligibleAmountCents)} eligible`,
  );

  if (gates.terminal) {
    const decision = resolveDecision(
      db,
      retrieval.found,
      gates,
      intake.evaluations,
      [],
      { extraction: null, grounding: null, proposal: null },
      intake.customer,
      deps.discretion ?? DEFAULT_DISCRETION,
      // No claim was read, so the floor has nothing to apply to.
      undefined,
    );
    log.record('resolve', `${decision.decision} ${formatCents(decision.refundAmountCents)}`);
    // Decided by a rule, without the model: the claim was never read, so the ladder
    // had nothing to do and there is nothing to explain to the customer.
    return {
      stage: 'decided',
      customer: intake.customer,
      order: retrieval.order,
      decision,
      extraction: null,
      grounding: null,
      injection: intake.injection,
      responseText: composeReply(decision, retrieval.order, input.message, log),
      notice: null,
      llmCalled: false,
      aiMode: mode,
      timings: log.all(),
      resolvedOrderId: retrieval.order?.id ?? null,
      itemIds: retrieval.found.items.map((item) => item.id),
    };
  }

  return await afterGates(db, deps, input, gates, retrieval, intake, observer, log, mode);
}

async function afterGates(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  intake: Intake,
  observer: AttemptObserver,
  log: StageLog,
  mode: string,
): Promise<ProcessResult> {
  const analysis = await analyseClaim(db, deps, input, gates, retrieval, intake, observer, log);
  if (analysis.outcome === 'question') {
    return askedResult(analysis.question, retrieval.order, retrieval.found.items.map((item) => item.id), intake, true, mode, log, analysis.notice ?? null);
  }
  if (analysis.outcome === 'picker') {
    return pickerResult(analysis, retrieval, intake, mode, log);
  }

  const reasonEvaluations = runReasonRules(retrieval.context, gates, analysis, log);
  const decision = resolveDecision(
    db,
    retrieval.found,
    gates,
    intake.evaluations,
    reasonEvaluations,
    analysis,
    intake.customer,
    deps.discretion ?? DEFAULT_DISCRETION,
    deps.minConfidence,
  );
  log.record('resolve', `${decision.decision} ${formatCents(decision.refundAmountCents)}`);

  const question = unreadableFollowUp(db, input, retrieval, intake, reasonEvaluations, decision, log);
  if (question !== null) {
    return askedResult(question, retrieval.order, retrieval.found.items.map((item) => item.id), intake, true, mode, log);
  }

  return decidedResult(input.message, analysis, decision, retrieval, intake, mode, log);
}

/**
 * Asks the question that might make the escalation unnecessary.
 *
 * R-12 is the safety valve: it fires when the model cannot point at words in the
 * customer's message that support a reason. That is very often a conversation that has
 * not been asked anything yet - "the item seems to have a problem" - and paging a
 * person for it spends a scarce resource on a message that one question would have
 * answered. So the valve gets one chance to become a question instead.
 *
 * Three conditions, and each is load-bearing:
 *
 *  - **R-12 must be the only thing that objected.** If a rule about money (R-03) or
 *    risk (R-07, R-08) also escalated, the escalation is about the case rather than
 *    about the reading, and asking "what has gone wrong?" would add a turn and change
 *    nothing. This is checked against the evaluations rather than by re-reading the
 *    claim, because R-12 is the authority on what "unreadable" means.
 *  - **An injection signal disqualifies it.** On a flagged message the content is
 *    untrustworthy, so an invitation to say more is an invitation to say more of it.
 *  - **Nothing may have been asked already.** `questionForField` returns null for a
 *    question this thread has already put, which is what stops the loop: ask once, and
 *    if the answer is still unreadable the request escalates for a person, as before.
 */
function unreadableFollowUp(
  db: Db,
  input: ProcessInput,
  retrieval: Retrieval,
  intake: Intake,
  reasonEvaluations: readonly RuleEvaluation[],
  decision: RefundDecision,
  log: StageLog,
): string | null {
  if (decision.decision !== 'escalated' || intake.injection.detected) {
    return null;
  }
  const objected = reasonEvaluations.filter((rule) => rule.outcome !== 'pass');
  const onlyTheValve = objected.length > 0 && objected.every((rule) => rule.ruleId === 'R-12' && rule.outcome === 'escalate');
  if (!onlyTheValve) {
    return null;
  }

  const order = retrieval.order;
  const history = transcriptForOrder(db, input.customerId, order?.id ?? null, input.now, HISTORY_LIMIT);
  const facts = threadFacts(db, input.customerId, order, history, input.message);
  const field = nextMissingField({ order, ...facts, resolvedItemIds: retrieval.found.items.map((i) => i.id), askedText: assistantLines(history) });
  if (field === null) {
    return null;
  }
  const targeted = questionForField(field, { order, ...facts, resolvedItemIds: retrieval.found.items.map((i) => i.id), askedText: assistantLines(history) });
  if (targeted === null) {
    return null;
  }

  log.record(
    'resolve',
    `R-12 could not read a reason and nothing else objected, so asking for ${field} ` +
      'rather than escalating; a second unreadable message still escalates',
  );

  // Opened with the same acknowledgement a decision would have carried, because the
  // reason for asking is the same reason for acknowledging: a bare image link is
  // unreadable to us, and "tell me in a few words what arrived" is the answer to
  // that. Without it the customer gets a bare question about a message they
  // believed was perfectly clear.
  const acknowledgement = acknowledgementFor(input.message);
  return acknowledgement === '' ? targeted : `${acknowledgement} ${targeted}`;
}

/**
 * The decided branch, as one result.
 *
 * Its own function so the three branches of the pipeline read alike, and so the
 * ladder's `notice` has one place to be attached rather than being threaded through
 * the stage body.
 */
function decidedResult(
  message: string,
  analysis: Extract<AnalyseOutcome, { outcome: 'claim' }>,
  decision: RefundDecision,
  retrieval: Retrieval,
  intake: Intake,
  mode: string,
  log: StageLog,
): Extract<ProcessResult, { stage: 'decided' }> {
  return {
    stage: 'decided',
    customer: intake.customer,
    order: retrieval.order,
    decision,
    extraction: analysis.extraction,
    grounding: analysis.grounding,
    injection: intake.injection,
    responseText: composeReply(decision, retrieval.order, message, log),
    notice: analysis.notice ?? null,
    llmCalled: true,
    aiMode: mode,
    timings: log.all(),
    resolvedOrderId: retrieval.order?.id ?? null,
    itemIds: retrieval.found.items.map((item) => item.id),
  };
}

interface Intake {
  readonly customer: CustomerRecord;
  readonly injection: InjectionScan;
  readonly evaluations: RuleEvaluation[];
  readonly context: PolicyContext;
}

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

function clarifyOrder(
  found: Identification,
  analyzer: AIAnalyzer,
  injection: InjectionScan,
  log: StageLog,
): string | null {
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

/**
 * What stage 4 produced, and what the customer is told about how.
 *
 * `notice` is present only when the ladder had to do something the customer would
 * otherwise not know about - a soft retry that worked, a matcher reading the
 * message, or a claim nobody could read. It is deliberately separate from
 * `responseText`: that is what the customer is *told*, and it must not carry
 * operational detail. The notice is what happened, in one sentence.
 */
type AnalyseOutcome =
  | ({ readonly outcome: 'claim'; readonly notice?: string } & Analysis)
  | {
      readonly outcome: 'question';
      readonly question: string;
      readonly model: string;
      readonly notice?: string;
    }
  /**
   * The item picker, offered instead of a claim.
   *
   * `itemIds` is empty by construction. An offer narrows nothing until it is
   * answered, and the answer arrives as the customer's own `itemIds` on their next
   * message - which is why this variant cannot carry scope of its own.
   */
  | {
      readonly outcome: 'picker';
      readonly notice?: string;
      readonly question: string;
      readonly model: string;
      readonly itemIds: readonly string[];
      readonly offer: ItemPickerOffer;
    };

const NO_ANALYSIS: { readonly outcome: 'claim'; readonly notice?: string } & Analysis = {
  outcome: 'claim',
  extraction: null,
  grounding: null,
  proposal: null,
};

/** How long the ladder pauses before its one extra pass. */
const SOFT_RETRY_PAUSE_MS = 400;

/** What the customer is told, in their own terms, at each rung. */
const RETRY_SUCCEEDED_NOTICE =
  'We had trouble reading your first message and tried again. Nothing was missed.';
const UNREADABLE_NOTICE =
  'We could not read your message automatically just now, so a person will pick it up and read it themselves.';

/**
 * The degradation ladder, once the models have all failed.
 *
 * Three rungs, and the shape of it is the argument for the whole file:
 *
 *  1. **Say so.** The customer is told, before anything else happens, that their
 *     message could not be read and is being tried again. A pause with nothing on
 *     screen is indistinguishable from a broken product, and that is the single
 *     complaint this ladder exists to answer.
 *  2. **Soft retry.** One more full pass, with its own time budget, after a beat
 *     long enough that a provider which was mid-outage has finished rebooting. Not
 *     a schema repair and not a token-cheap probe: the same request, once more,
 *     because the failure was in reaching the model rather than in what it said.
 *  3. **A person, and an explanation.** With no claim, the request escalates - which
 *     is where it always went - but the customer is now told that their message
 *     could not be read, rather than being handed an escalation notice
 *     indistinguishable from a policy one.
 *
 * There is deliberately no fourth rung. A pattern matcher reading the claim was tried
 * here and removed: it is a second, untested reader of a document that decides money,
 * and the difference between "the model read this and the policy refused it" and
 * "a regex read this and the policy approved it" is not a wording difference. So an
 * unreachable model means no claim, and a request nobody could read goes to a person
 * - which is slow, and honest, and the only answer that does not quietly invent
 * evidence.
 */
async function readWithLadder(
  reason: string,
  deps: PipelineDeps,
  input: ProcessInput,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  observer: AttemptObserver,
  log: StageLog,
): Promise<AnalyseOutcome> {
  const first = truncate(reason, 120);
  deps.notifyCustomer?.(input.customerId);

  const retried = await softRetry(deps, input, order, history, observer);
  if (retried !== null) {
    log.record('ai_analysis', `no usable extraction (${first}); the soft retry read it`);
    return { outcome: 'claim', ...retried, proposal: null, notice: RETRY_SUCCEEDED_NOTICE };
  }

  log.record('ai_analysis', `no usable extraction (${first}); escalating for a person to read`);
  return { ...NO_ANALYSIS, notice: UNREADABLE_NOTICE };
}

/**
 * One more pass at the models, after a pause.
 *
 * Bounded and named: one extra attempt, once, with its own budget from the adapter.
 * The pause is short enough to stay inside a customer's patience and long enough to
 * outlast a provider that was restarting.
 */
async function softRetry(
  deps: PipelineDeps,
  input: ProcessInput,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  observer: AttemptObserver,
): Promise<Omit<Analysis, 'proposal'> | null> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, SOFT_RETRY_PAUSE_MS);
  });
  try {
    const reply = await deps.analyzer.analyze(
      { message: input.message, order: toAnalyzerOrder(order), history },
      observer,
    );
    if (reply.kind !== 'complete') {
      return null;
    }
    const extraction = reply.extraction;
    const corpus = [...history.filter((line) => line.role === 'customer').map((line) => line.text), input.message];
    const grounding = verifyGrounding(extraction, corpus);
    return grounding === null || !grounding.grounded ? null : { extraction, grounding };
  } catch {
    // A failed soft retry is not an error: the ladder has a next step, and the
    // adapter has already written the reason into the attempt log.
    return null;
  }
}

/**
 * Stage 4: the intake call, plus the grounding check on its output.
 *
 * The model is an intake specialist, so this is one call per turn: it either
 * asks one question, which leaves the pipeline as `asked`, or it hands back a
 * complete `ClaimExtraction`. The clarification loop is therefore a loop across
 * *requests*, not inside one - the question is stored, the customer's answer
 * arrives as the next message with the transcript attached, and the model reads
 * it there. Looping inside a single request could not make progress, because the
 * only thing that answers a question is the customer.
 *
 * The catch on a provider failure is the point, not a convenience. Every rule has
 * already run on order facts by this stage, so a provider that is down,
 * rate-limited or simply wrong about the schema costs the request its evidence
 * and nothing else - and "no claim" can only escalate, never approve.
 */
async function analyseClaim(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  intake: Intake,
  observer: AttemptObserver,
  log: StageLog,
): Promise<AnalyseOutcome> {
  if (gates.terminal) {
    log.record('ai_analysis', 'not reached: fact gates terminated the request');
    return NO_ANALYSIS;
  }

  const order = retrieval.order;
  const history = transcriptForOrder(db, input.customerId, orderIdFor(order), input.now, HISTORY_LIMIT);

  const facts = threadFacts(db, input.customerId, order, history, input.message);
  const resolvedItemIds = retrieval.found.items.map((item) => item.id);

  const askedFirst = clarifyBeforeIntake(input.message, order, history, facts, resolvedItemIds, log);
  if (askedFirst !== null) {
    return askedFirst;
  }

  let reply: IntakeReply;
  try {
    reply = await deps.analyzer.analyze(
      {
        message: input.message,
        order: toAnalyzerOrder(order),
        history,
        // The engine already knows whether the line is settled, so the picker is
        // closed when it is: a model offered a door that leads nowhere will walk
        // through it. Observed doing exactly that on a complaint that named both the
        // item and the fault.
        allowedExits: resolvedItemIds.length > 0 ? ['ask', 'decide'] : ['ask', 'ask_items', 'decide'],
      },
      observer,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return await readWithLadder(reason, deps, input, order, history, observer, log);
  }

  if (reply.kind === 'ask_items') {
    return itemPickOrNextQuestion(reply, db, deps, input, gates, retrieval, history, intake, log);
  }

  if (reply.kind === 'question') {
    // A flagged message cannot leave through the question branch: doing so would
    // let model-authored text bypass R-14's denial/escalation entirely. Discard
    // the model response and continue with no claim so the resolver records the
    // configured integrity outcome.
    if (intake.injection.detected) {
      log.record('ai_analysis', 'discarded model question after an injection signal');
      return NO_ANALYSIS;
    }
    return respondToQuestion(reply, order, history, facts, resolvedItemIds, log);
  }

  // Only the customer's side of the transcript is eligible evidence. The model
  // may quote something the customer said two messages ago, but never its own
  // question and never its own phrasing.
  const extraction: ClaimExtraction = reply.extraction;
  const corpus = [...history.filter((line) => line.role === 'customer').map((line) => line.text), input.message];
  const grounding = verifyGrounding(extraction, corpus);
  log.record(
    'ai_analysis',
    `reason="${extraction.reason}" intent="${extraction.intent}" ` +
      `lang=${extraction.language} grounded=${groundedLabel(grounding)} ` +
      `via ${reply.model}`,
  );
  return { outcome: 'claim', extraction, grounding, proposal: null };
}

/**
 * Whether to put the item picker in front of the customer.
 *
 * One caller: the model asking through `ask_which_items`. `itemPickerOffer`
 * decides, and it can only say yes or withhold - the model asks, the server
 * decides. Two properties of this branch are load-bearing:
 *
 *  - **It never sets scope.** The offer is returned as a question-shaped result
 *    with no item ids attached. The scope that reaches the money arrives as the
 *    customer's `itemIds` on their next message, through the same field a manual
 *    tick uses - so there is no code path from model output to the dispute
 *    ceiling.
 *  - **It is not a question the model wrote.** A picker is buttons, so the
 *    deterministic caption is used and the model's candidates are treated as a
 *    hint about which lines to show.
 */
function offerItemPicker(
  reply: Extract<IntakeReply, { kind: 'ask_items' }>,
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  intake: Intake,
  log: StageLog,
): AnalyseOutcome | null {
  const offer = itemPickerOffer({
    db,
    customerId: input.customerId,
    order: retrieval.order,
    identification: retrieval.found,
    gates,
    injectionDetected: intake.injection.detected,
    handoffActive: activeHandoffForCustomer(db, input.customerId) !== null,
    request: { candidates: reply.candidates },
    config: deps.itemPicker ?? DEFAULT_ITEM_PICKER,
  });

  if (offer === null) {
    log.record('ai_analysis', 'item picker withheld: its conditions are not met');
    return null;
  }

  log.record(
    'ai_analysis',
    `offering the item picker for ${offer.items.length} line(s)` +
      `${offer.suggested.length > 0 ? `, model unsure about ${offer.suggested.join(', ')}` : ''}`,
  );
  return {
    outcome: 'picker',
    question: ITEM_PICKER_CAPTION,
    model: reply.model,
    itemIds: [],
    offer,
  };
}

/** The picker's caption. Deterministic: a model caption would be a second interface. */
const ITEM_PICKER_CAPTION = 'Which item is this about? Pick one and I will check the policy for that item.';

/**
 * What to do when the model asks which item the claim is about.
 *
 * Withheld is a normal outcome, not a failure: the model's request is a hint and the
 * conditions are the authority. But withholding the picker is not a reason to escalate.
 * The customer may already have chosen the item - the picker is skipped precisely
 * because they have - and then what is missing is the reason, which is a question and
 * not a person. Escalating there meant a perfectly clear complaint ("it arrived
 * cracked") was answered by summoning a human for a question the assistant could have
 * asked itself.
 *
 * So: offer the picker when it is warranted, otherwise ask whatever is still missing,
 * and only escalate when there is nothing left to ask.
 */
function itemPickOrNextQuestion(
  reply: Extract<IntakeReply, { kind: 'ask_items' }>,
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  history: readonly DialogueLine[],
  intake: Intake,
  log: StageLog,
): AnalyseOutcome {
  const offered = offerItemPicker(reply, db, deps, input, gates, retrieval, intake, log);
  if (offered !== null) {
    return offered;
  }
  const asked = askedClarifyingQuestion(
    db,
    input,
    retrieval.order,
    retrieval.found.items.map((item) => item.id),
    history,
    log,
  );
  if (asked !== null) {
    return asked;
  }

  // Nothing for us to ask, but the model wanted to ask something, and there is no
  // reason to override that with a page of policy. Its question goes through the same
  // guard as any other and the customer is asked it. Escalating here meant a model
  // that politely asked which item was involved could still produce a human being
  // summoned instead - the opposite of asking before escalating.
  if (intake.injection.detected) {
    return NO_ANALYSIS;
  }
  return respondToQuestion(
    { kind: 'question', question: `${PICKER_FALLBACK_QUESTION} ${reply.candidates.join(', ')}`.trim(), model: reply.model },
    retrieval.order,
    history,
    threadFacts(db, input.customerId, retrieval.order, history, input.message),
    retrieval.found.items.map((item) => item.id),
    log,
  );
}

/** Used when the model asked which item but the picker is not warranted. */
const PICKER_FALLBACK_QUESTION = 'Is this about';

/**
 * The one question the thread is missing, or null when nothing is.
 *
 * The same derivation the picker uses, so a thread that was not offered a picker
 * because the line was already known gets asked about the line's *fault* instead of
 * being handed to a person. Deterministic, and refused if the thread has already
 * asked it - the guard that stops the loop.
 */
function askedClarifyingQuestion(
  db: Db,
  input: ProcessInput,
  order: OrderRecord | null,
  resolvedItemIds: readonly string[],
  history: readonly DialogueLine[],
  log: StageLog,
): AnalyseOutcome | null {
  const facts = threadFacts(db, input.customerId, order, history, input.message);
  const field = nextMissingField({ order, ...facts, resolvedItemIds, askedText: assistantLines(history) });
  if (field === null) {
    return null;
  }
  const question = questionForField(field, { order, ...facts, resolvedItemIds, askedText: assistantLines(history) });
  if (question === null) {
    return null;
  }
  return respondToQuestion(
    { kind: 'question', question, model: 'deterministic-clarification-v1' },
    order,
    history,
    facts,
    // Everything already named is resolved scope, so the question must be about the
    // fault rather than the line.
    facts.reportedItemIds,
    log,
  );
}

/**
 * The two deterministic floors, in the order they run.
 *
 * Both are questions the customer can answer without a model: a damage report with
 * no observed condition, and a message that expresses no problem at all. They come
 * before intake so the model is never consulted for a case where the answer is
 * already known, which is what makes "the assistant asked" true of them.
 */
function clarifyBeforeIntake(
  message: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  facts: ThreadFacts,
  resolvedItemIds: readonly string[],
  log: StageLog,
): AnalyseOutcome | null {
  return (
    clarifyDamageReport(message, order, history, facts, resolvedItemIds, log) ??
    clarifyNoComplaint(message, order, history, facts, resolvedItemIds, log)
  );
}

/** Keep a damage report without observed condition out of policy analysis. */
function clarifyDamageReport(
  message: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  facts: ThreadFacts,
  resolvedItemIds: readonly string[],
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
    facts,
    resolvedItemIds,
    log,
  );
}

/** Keep greetings and social-only turns out of claim analysis. */
function clarifyNoComplaint(
  message: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  facts: ThreadFacts,
  resolvedItemIds: readonly string[],
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
    facts,
    resolvedItemIds,
    log,
  );
}

/**
 * The thread's facts, for the question that gets asked next.
 *
 * `reportedItemIds` comes from the order's own requests rather than from the
 * transcript, because the transcript cannot tell a line that already carries a claim
 * from one that merely went unmentioned - and offering a choice that has already been
 * decided is the one way a picker becomes worse than a question.
 */
function threadFacts(
  db: Db,
  customerId: string,
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  message: string,
): ThreadFacts {
  return {
    reportedItemIds: order === null ? [] : reportedItemIds(db, customerId, order.id),
    // The newest message is not in `history` yet: it is what the assistant is being
    // asked about, and reasoning about a transcript that omits it would answer the
    // wrong question.
    customerText: [
      ...history.filter((turn) => turn.role === 'customer').map((turn) => turn.text),
      message,
    ],
  };
}

/**
 * The deterministic floor under the intake specialist's questions.
 *
 * The prompt tells the model never to open with a greeting, never to demand an
 * order number the pipeline has resolved, and never to repeat itself; the guard
 * makes those rules hold when the model ignores them. A canned question is
 * replaced with a warm restatement, a repeat hands the thread to a person, and
 * only a real question reaches the customer.
 */
/** The thread facts the next question is derived from. */
type ThreadFacts = Pick<NextQuestionInput, 'reportedItemIds' | 'customerText'>;

function respondToQuestion(
  reply: IntakeReply & { readonly kind: 'question' },
  order: OrderRecord | null,
  history: readonly DialogueLine[],
  facts: ThreadFacts,
  resolvedItemIds: readonly string[],
  log: StageLog,
): AnalyseOutcome {
  const refined = refineQuestion(reply.question, {
    orderResolved: order !== null,
    priorAssistantText: assistantLines(history),
    next: { order, ...facts, resolvedItemIds, askedText: assistantLines(history) },
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

/**
 * The picker as a result the route can publish.
 *
 * Carries the deterministic caption for the thread's text and the offer for the
 * interface to render, and no item ids - the scope is the customer's to give.
 */
function pickerResult(
  analysis: Extract<AnalyseOutcome, { outcome: 'picker' }>,
  retrieval: Retrieval,
  intake: Intake,
  mode: string,
  log: StageLog,
): Extract<ProcessResult, { stage: 'asked' }> {
  return {
    stage: 'asked',
    question: analysis.question,
    picker: analysis.offer,
    notice: analysis.notice ?? null,
    customer: intake.customer,
    order: retrieval.order,
    resolvedOrderId: retrieval.order?.id ?? null,
    itemIds: [],
    injection: intake.injection,
    llmCalled: true,
    aiMode: mode,
    timings: log.all(),
  };
}

function askedResult(
  question: string,
  order: OrderRecord | null,
  itemIds: readonly string[],
  intake: Intake,
  llmCalled: boolean,
  aiMode: string,
  log: StageLog,
  notice: string | null = null,
): Extract<ProcessResult, { stage: 'asked' }> {
  return {
    stage: 'asked',
    question,
    picker: null,
    notice: notice ?? null,
    customer: intake.customer,
    order,
    resolvedOrderId: order?.id ?? null,
    itemIds,
    injection: intake.injection,
    llmCalled,
    aiMode,
    timings: log.all(),
  };
}

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
  customer: CustomerRecord,
  discretion: DiscretionConfig,
  minConfidence: number | undefined,
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
    extraction: analysis.extraction,
    customer,
    discretion,
    minConfidence,
  });
}

function composeReply(decision: RefundDecision, order: OrderRecord | null, message: string, log: StageLog): string {
  const text = composeDeterministicResponse(decision, order, message);
  log.record('respond', 'composed from the decision, no model in this path');
  return text;
}

export { DEFAULT_DISCRETION };
