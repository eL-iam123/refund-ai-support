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
import type { ClarifyField } from './ai/analyzer.js';
import { toAnalyzerOrder } from './ai/openaiAnalyzer.js';
import { disputeCeiling, identifyOrder, type Identification } from './retrieval/identifyOrder.js';
import { scanForInjection } from './security/injection.js';
import { transcriptForOrder } from './retrieval/conversation.js';
import { adoptDialogueToOrder } from './db/dialogue.js';
import { liveHandoffForThread } from './db/handoffs.js';
import { runFactGates, type GateResult } from './policy/gates.js';
import { evaluateRule, evaluateRules } from './policy/engine.js';
import { DEFAULT_DISCRETION } from './policy/discretion.js';
import { R14RequestIntegrity } from './policy/rules/R-14-request-integrity.js';
import { rulesForStage } from './policy/rules/index.js';
import { resolve } from './policy/resolver.js';
import { ESCALATION_CEILING_CENTS } from './policy/constants.js';
import type { PolicyContext } from './policy/types.js';
import { composeDeterministicResponse } from './response/compose.js';
import { isNoComplaint, noComplaintQuestion, NO_COMPLAINT_MODEL } from './response/noComplaint.js';
import { isPolicyQuestion, policyAnswerForOrder } from './response/policyQuestion.js';
import { clarifySparseDamage } from './response/claimClarification.js';
import { assistantLines, refineQuestion } from './response/questionGuard.js';
import { nextMissingField, questionForField, type NextQuestionInput } from './response/nextQuestion.js';
import { acknowledgementFor } from './response/acknowledge.js';
import { confirmsIntent, picksRefund, wantsAnAgent } from './response/intent.js';
import { buildPhraseEnvelope } from './response/envelope.js';
import { inferTone } from './response/tone.js';
import { isSafePhrasedReply } from './ai/replyGuard.js';
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
   * The order-total ceiling above which R-15 escalates to a person.
   *
   * Optional, defaulting to the `ESCALATION_CEILING_CENTS` schema default. It
   * can only ever escalate a request that names a large order, never approve
   * one, so omitting it cannot widen what is paid.
   */
  readonly escalationCeilingCents?: number;
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
  /**
   * Order identification the caller already ran.
   *
   * Optional so older callers keep working: when absent the retrieve stage
   * runs it itself. The chat route passes its own result down so one request
   * does not identify the same order twice with possibly different answers.
   */
  readonly identification?: Identification | undefined;
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
      /** Agent-facing case summary written by the model, or null. */
      readonly caseSummary: string | null;
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
      /** Agent-facing case summary written by the model, or null. */
      readonly caseSummary: string | null;
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

  const intake = runIntake(db, input, deps.injectionAction, deps.escalationCeilingCents ?? ESCALATION_CEILING_CENTS, log);
  const retrieval = retrieveOrder(db, input, intake, log);

  if (retrieval.order !== null) {
    adoptDialogueToOrder(db, input.customerId, retrieval.order.id);
  }

  const mode = `${deps.analyzer.label} (${deps.analyzer.model})`;
  const clarification = clarifyOrder(retrieval.found, deps.analyzer, intake.injection, log);
  if (clarification !== null) {
    return askedResult(clarification, retrieval.order, retrieval.found.items.map((item) => item.id), intake, false, mode, log);
  }

  if (retrieval.order !== null && isPolicyQuestion(input.message)) {
    const gates = runFactGates(retrieval.context, input.itemIds);
    const answer = policyAnswerForOrder(retrieval.order, input.itemIds, gates.blockedItems);
    if (answer !== null) {
      log.record('ai_analysis', 'policy question; answered from the deterministic floor, no claim filed');
      return askedResult(answer, retrieval.order, input.itemIds, intake, false, mode, log);
    }
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
    return decidedByGates(db, deps, input, gates, retrieval, intake, mode, log, observer);
  }

  return await afterGates(db, deps, input, gates, retrieval, intake, observer, log, mode);
}

/**
 * A request the fact gates ended, decided without the model.
 *
 * The claim was never read, so the ladder had nothing to do and there is
 * nothing to explain to the customer. Split out because the entry point owns
 * the stage ordering, not any one outcome: seven stages are already one
 * function too many to hold in a reader's head.
 */
async function decidedByGates(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  intake: Intake,
  mode: string,
  log: StageLog,
  observer: AttemptObserver,
): Promise<Extract<ProcessResult, { stage: 'decided' }>> {
  const customerRequestedAgent = wantsAnAgent(input.message);
  if (customerRequestedAgent) {
    log.record('intake', 'the customer asked to speak to an agent');
  }
  const order = retrieval.order;
  const validItemIds = order
    ? input.itemIds.filter((id) => order.items.some((item) => item.id === id))
    : input.itemIds;
  const decision = resolveDecision(
    db,
    retrieval.found,
    gates,
    intake.evaluations,
    [],
    { extraction: null, grounding: null, proposal: null },
    intake.customer,
    deps.discretion ?? DEFAULT_DISCRETION,
    undefined,
    customerRequestedAgent,
    validItemIds,
    input.message,
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
    responseText: await phraseReply(deps, observer, db, {
      customerId: input.customerId,
      customerName: intake.customer.name,
      message: input.message,
      now: input.now,
      order: retrieval.order,
      decision,
      verifiedQuotes: [],
    }, log),
    notice: null,
    llmCalled: false,
    aiMode: mode,
    timings: log.all(),
    resolvedOrderId: retrieval.order?.id ?? null,
    itemIds: retrieval.found.items.map((item) => item.id),
    caseSummary: null,
  };
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

  const reasonEvaluations = runReasonRules(retrieval.context, gates, analysis, log, input.itemIds);
  const customerRequestedAgent = wantsAnAgent(input.message);
  if (customerRequestedAgent) {
    log.record('intake', 'the customer asked to speak to an agent');
  }
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
    customerRequestedAgent,
    input.itemIds,
    input.message,
  );
  log.record('resolve', `${decision.decision} ${formatCents(decision.refundAmountCents)}`);

  const question = unreadableFollowUp(db, input, retrieval, intake, reasonEvaluations, decision, log);
  if (question !== null) {
    return askedResult(question, retrieval.order, retrieval.found.items.map((item) => item.id), intake, true, mode, log);
  }

  const history = transcriptForOrder(db, input.customerId, orderIdFor(retrieval.order), input.now, HISTORY_LIMIT);
  const consent = consentCheck(db, input, orderIdFor(retrieval.order), history, decision);
  if (consent !== null) {
    return askedResult(consent, retrieval.order, retrieval.found.items.map((item) => item.id), intake, true, mode, log);
  }

  return await decidedResult(db, input, analysis, decision, retrieval, intake, mode, log, deps, observer);
}

/**
 * Asks before storing money the customer never asked for.
 *
 * The bar for moving money is not "we understood" but "they asked". A payable
 * decision comes back as a question instead of a stored decision unless the
 * customer asked for money back in so many words or confirmed the question
 * below one turn ago. Stating a problem is never consent: "broken", "late"
 * and "different from what I ordered" all describe what happened, and none
 * of them chooses the remedy.
 *
 * "Return" is logistics, not money: asking to send goods back is not asking
 * to be paid, so only refund and money-back words count as the ask.
 *
 *  - **Only payable decisions are gated.** Anything else has no money to stop.
 *  - **A refusal is never gated.** Confirming a denial would ask a customer to
 *    agree to being refused, which is theatre.
 *
 * The confirmation is recognised on the next turn by its own text, so a
 * customer who simply says "yes" is confirmed without restating anything.
 */
function consentCheck(
  db: Db,
  input: ProcessInput,
  orderId: string | null,
  history: readonly DialogueLine[],
  decision: RefundDecision,
): string | null {
  const pays = decision.decision === 'approved' || decision.decision === 'partial_refund';
  if (!pays) {
    return null;
  }

  const customerText = [...history, { role: 'customer' as const, text: input.message }]
    .filter((turn) => turn.role === 'customer')
    .map((turn) => turn.text)
    .join('\n');

  // Already answered, two ways: money back in this message, in so many words,
  // or agreement with this confirmation one turn ago. The ask is read off the
  // message alone, not the thread: money asked for one problem is not consent
  // for the next, and a thread that remembered every past ask would approve
  // each new claim on the strength of an old one. A stated fault is
  // deliberately not consent - the remedy is the customer's to choose,
  // whatever broke.
  if (picksRefund(input.message)) {
    return null;
  }
  if (wasConfirmedJustNow(db, input.customerId, orderId, input.message)) {
    return null;
  }

  return confirmationQuestion(customerText, decision);
}

/**
 * The claim a confirmation answer is answering, if it is answering one.
 *
 * A "yes" carries no claim of its own: analysed on its own words it evaporates
 * into an escalation, and matched as a duplicate it collides with every other
 * short answer on the order. So when the thread's latest dialogue turn is the
 * remedy confirmation and the message confirms it, the claim that turn records
 * stands in for analysis. Returns null for anything else, and analysis
 * proceeds on the message itself.
 *
 * Read straight from the dialogue table in rowid order, not off the merged
 * transcript: the transcript sorts ties by kind, so under a fixed clock the
 * "last" turn is whichever kind ranked highest rather than what was actually
 * said last. Insertion order is the only order that means latest here.
 */
export function confirmingClaimText(
  db: Db,
  customerId: string,
  orderId: string | null,
  message: string,
): string | null {
  if (orderId === null || !confirmsIntent(message)) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT customer_message, assistant_question FROM shop_dialogue
        WHERE customer_id = ? AND order_id IS ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(customerId, orderId) as
    | { customer_message: string; assistant_question: string }
    | undefined;
  if (row === undefined || !row.assistant_question.includes(CONFIRMATION_MARK)) {
    return null;
  }
  return row.customer_message.trim().length > 0 ? row.customer_message : null;
}
/**
 * Did the customer agree with the confirmation asked one turn ago?
 *
 * Read off the latest dialogue row rather than the merged transcript, for the
 * same rowid-ordering reason as `confirmingClaimText`: only the *immediately*
 * preceding question counts, and insertion order is what "preceding" means.
 * An affirmative to a question about which item is not consent to a refund,
 * and treating it as consent is the failure this whole feature exists to
 * prevent.
 */
function wasConfirmedJustNow(db: Db, customerId: string, orderId: string | null, message: string): boolean {
  return confirmingClaimText(db, customerId, orderId, message) !== null;
}

/**
 * The options, assembled from what the policy would actually do.
 *
 * Not a yes/no and not a fixed menu: an acknowledgement in the customer's own
 * words, then the outcomes this order can really reach, then the person.
 * Offering something the policy will refuse is worse than offering nothing. So
 * the refund is offered only when a refund is what would happen, and "speak to
 * an agent" is always offered - the one option that is never refused.
 */
function confirmationQuestion(customerText: string, decision: RefundDecision): string {
  const said = lastLine(customerText);
  const options: string[] = [];
  if (decision.decision === 'approved' || decision.decision === 'partial_refund') {
    options.push(`a refund of ${formatCents(decision.refundAmountCents)}`);
  }
  if (decision.decision === 'exchange' || decision.decision === 'store_credit') {
    options.push(decision.decision === 'exchange' ? 'a replacement item' : 'store credit');
  }
  options.push('to speak to an agent');

  const offer =
    options.length > 1
      ? `Our policy would allow ${options.slice(0, -1).join(' or ')} here - or `
      : 'The options our policy allows here are ';
  return (
    `${CONFIRMATION_MARK} Thank you - you have told us "${said.length <= 120 ? said : `${said.slice(0, 119)}…`}". ` +
    `Before we do anything: ${offer}${options[options.length - 1]}. ` +
    `Nothing will be refunded or arranged until you tell us which you want. ` +
    `If the problem is something else, just describe it and we will look again.`
  );
}

/** The most recent thing they said, which is the part being answered. */
function lastLine(customerText: string): string {
  const lines = customerText.trim().split('\n').filter((line) => line.trim().length > 0);
  return lines[lines.length - 1]?.trim() ?? '';
}

/**
 * A stable marker, so the next turn can recognise the question it is answering.
 *
 * A phrase rather than a flag in the database: it has to survive a page reload,
 * a second device and a resumed conversation, and the thread already stores
 * what was asked.
 */
const CONFIRMATION_MARK = 'Before we refund anything:';

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
async function decidedResult(
  db: Db,
  input: ProcessInput,
  analysis: Extract<AnalyseOutcome, { outcome: 'claim' }>,
  decision: RefundDecision,
  retrieval: Retrieval,
  intake: Intake,
  mode: string,
  log: StageLog,
  deps: PipelineDeps,
  observer: AttemptObserver,
): Promise<Extract<ProcessResult, { stage: 'decided' }>> {
  return {
    stage: 'decided',
    customer: intake.customer,
    order: retrieval.order,
    decision,
    extraction: analysis.extraction,
    grounding: analysis.grounding,
    injection: intake.injection,
    responseText: await phraseReply(deps, observer, db, {
      customerId: input.customerId,
      customerName: intake.customer.name,
      message: input.message,
      now: input.now,
      order: retrieval.order,
      decision,
      verifiedQuotes: analysis.grounding?.verifiedQuotes ?? [],
    }, log),
    notice: analysis.notice ?? null,
    llmCalled: true,
    aiMode: mode,
    timings: log.all(),
    resolvedOrderId: retrieval.order?.id ?? null,
    itemIds: retrieval.found.items.map((item) => item.id),
    caseSummary: await caseSummary(deps, observer, input.message, decision, analysis, log),
  };
}

/**
 * The agent-facing case note, computed after the decision and used nowhere else.
 *
 * The ordering is the whole safety property: `decision` is already fixed when this
 * runs, the value goes into the stored row and the DTO, and no resolver input can
 * see it. A summary that could influence the outcome would be a place for a model to
 * argue for money, which is the one thing this system is built to make impossible.
 *
 * Only cases a person will actually read get one. A clean auto-approval needs no
 * briefing, and asking the model about every order would spend a provider call and
 * the customer's latency on a paragraph nobody opens.
 */
async function caseSummary(
  deps: PipelineDeps,
  observer: AttemptObserver,
  message: string,
  decision: RefundDecision,
  analysis: Extract<AnalyseOutcome, { outcome: 'claim' }>,
  log: StageLog,
): Promise<string | null> {
  if (decision.decision === 'approved') {
    return null;
  }
  const verifiedQuotes = analysis.grounding?.verifiedQuotes ?? [];
  try {
    const note = await deps.analyzer.summariseCase(
      {
        customerMessage: message,
        outcome: {
          decision: decision.decision,
          amountCents: decision.refundAmountCents,
          summary: decision.summary,
          policyRef: decision.policyRef,
        },
        verifiedQuotes,
      },
      observer,
    );
    if (note !== null) {
      // `respond`, not a stage of its own: `STAGES` is a published enum that every
      // client renders timings from, and one more value would mean every one of them
      // learns about a stage most will never see.
      log.record('respond', `case note written for ${decision.decision}`);
    }
    return note;
  } catch (error: unknown) {
    // Contract says null rather than an error, so this should be unreachable; a missing
    // case note is never worth failing a refund over, so it is caught anyway.
    log.record('respond', `case note unavailable (${truncate(error instanceof Error ? error.message : String(error), 80)})`);
    return null;
  }
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
  escalationCeilingCents: number,
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
    escalationCeilingCents,
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
  const found =
    input.identification ??
    identifyOrder(db, intake.customer, input.orderId, input.message, input.now, input.itemIds);
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

  // A confirmation answer carries no claim of its own: analyse the claim it
  // answers instead of the bare affirmation, or "yes" evaporates into an
  // escalation and the confirmation can never complete.
  const claimedMessage =
    confirmingClaimText(db, input.customerId, orderIdFor(order), input.message) ?? input.message;

  const facts = threadFacts(db, input.customerId, order, history, claimedMessage);
  const resolvedItemIds = retrieval.found.items.map((item) => item.id);

  const askedFirst = clarifyBeforeIntake(claimedMessage, order, history, facts, resolvedItemIds, log);
  if (askedFirst !== null) {
    return askedFirst;
  }

  let reply: IntakeReply;
  try {
    reply = await deps.analyzer.analyze(
      {
        message: claimedMessage,
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
    return itemPickOrNextQuestion(reply, db, deps, input, gates, retrieval, history, intake, log, observer);
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
    handoffActive: liveHandoffForThread(db, input.customerId, retrieval.order?.id ?? null) !== null,
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
async function itemPickOrNextQuestion(
  reply: Extract<IntakeReply, { kind: 'ask_items' }>,
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  gates: GateResult,
  retrieval: Retrieval,
  history: readonly DialogueLine[],
  intake: Intake,
  log: StageLog,
  observer: AttemptObserver,
): Promise<AnalyseOutcome> {
  const offered = offerItemPicker(reply, db, deps, input, gates, retrieval, intake, log);
  if (offered !== null) {
    return offered;
  }
  const asked = await askedClarifyingQuestion(
    db,
    deps,
    input,
    retrieval.order,
    retrieval.found.items.map((item) => item.id),
    history,
    log,
    observer,
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
async function askedClarifyingQuestion(
  db: Db,
  deps: PipelineDeps,
  input: ProcessInput,
  order: OrderRecord | null,
  resolvedItemIds: readonly string[],
  history: readonly DialogueLine[],
  log: StageLog,
  observer: AttemptObserver,
): Promise<AnalyseOutcome | null> {
  const facts = threadFacts(db, input.customerId, order, history, input.message);
  const field = nextMissingField({ order, ...facts, resolvedItemIds, askedText: assistantLines(history) });
  if (field === null) {
    return null;
  }
  const askedInput = { order, ...facts, resolvedItemIds, askedText: assistantLines(history) };
  const model = await clarifyWithModel(deps, observer, field, order, resolvedItemIds, input.message, log);
  const question = model ?? questionForField(field, askedInput);
  if (question === null) {
    return null;
  }
  return respondToQuestion(
    {
      kind: 'question',
      question,
      model: model === null ? 'deterministic-clarification-v1' : deps.analyzer.model,
    },
    order,
    history,
    facts,
    // The scope that was actually resolved for *this* request, which is not the same
    // thing as the lines that carry an earlier claim. Passing the wrong one here made
    // the guard believe the item was still unknown and replace the reason question
    // with the item question - so a customer who had just picked the mug was asked
    // which item, again, by the component meant to be asking what was wrong with it.
    resolvedItemIds,
    log,
  );
}

/**
 * Words the missing field with the model when one can ask, deterministically otherwise.
 *
 * The field derivation above stays deterministic - what is missing is a fact
 * about the thread, not a judgement call. Only the wording goes to the model,
 * with product names and kinds but never money, and the question guard still
 * checks the result for repeats before anyone reads it. Null (no model, failed
 * call, invalid text) means the deterministic question, so a model that cannot
 * ask plainly costs a round trip, never the turn.
 */
const MAX_QUESTION_CHARS = 400;

async function clarifyWithModel(
  deps: PipelineDeps,
  observer: AttemptObserver,
  field: ClarifyField,
  order: OrderRecord | null,
  resolvedItemIds: readonly string[],
  message: string,
  log: StageLog,
): Promise<string | null> {
  if (deps.analyzer.askClarification === undefined) {
    return null;
  }
  try {
    const text = await deps.analyzer.askClarification(
      {
        field,
        items: clarifyScope(order, resolvedItemIds).map((line) => ({ name: line.name, kind: clarifyKind(line) })),
        message,
      },
      observer,
    );
    // Validated here as well as in the adapters: a custom analyzer can return
    // anything, and an empty question would sail through the repeat guard
    // (nothing asked yet) straight to the customer as a blank bubble.
    if (text === null) {
      log.record('ai_analysis', 'model clarification unavailable; deterministic question');
      return null;
    }
    const wording = text.trim();
    if (wording.length === 0 || wording.length > MAX_QUESTION_CHARS || /\$\s?\d/.test(wording)) {
      log.record('ai_analysis', 'model clarification rejected by validation; deterministic question');
      return null;
    }
    return wording;
  } catch {
    log.record('ai_analysis', 'model clarification failed; deterministic question');
    return null;
  }
}

/** The lines a clarification question may name: resolved if any, else the basket. */
function clarifyScope(order: OrderRecord | null, resolvedItemIds: readonly string[]): readonly OrderRecord['items'][number][] {
  const lines = order === null ? [] : order.items.filter((line) => resolvedItemIds.includes(line.id));
  return lines.length > 0 ? lines : (order?.items ?? []);
}

/** What a line is, for fitting examples to it: billing, access, or a thing. */
function clarifyKind(line: { readonly isSubscription: boolean; readonly digital: boolean }): 'subscription' | 'digital' | 'physical' {
  if (line.isSubscription) {
    return 'subscription';
  }
  if (line.digital) {
    return 'digital';
  }
  return 'physical';
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
    caseSummary: null,
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
    caseSummary: null,
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
  claimedItemIds?: readonly string[],
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
    ...(claimedItemIds !== undefined ? { claimedItemIds } : {}),
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
  customerRequestedAgent: boolean = false,
  claimedItemIds?: readonly string[],
  customerMessage?: string,
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
    customerRequestedAgent,
    claimedItemIds,
    customerMessage,
  });
}

/** Everything the writer may know: the closed envelope plus the customer's own words. */
interface PhraseRequest {
  readonly customerId: string;
  readonly customerName: string;
  readonly message: string;
  readonly now: Date;
  readonly order: OrderRecord | null;
  readonly decision: RefundDecision;
  readonly verifiedQuotes: readonly string[];
}

/**
 * The reply in the customer's language: model phrasing over a fixed envelope,
 * deterministic text when anything about the model path fails.
 *
 * The ordering is the safety property, mirroring the case summary below:
 * `decision` is already fixed, the envelope is built from it
 * deterministically, and the model's prose is validated against that envelope
 * before it can reach a customer. Nothing here flows back into the resolver -
 * the writer's only influence is which sentence goes first.
 */
async function phraseReply(
  deps: PipelineDeps,
  observer: AttemptObserver,
  db: Db,
  request: PhraseRequest,
  log: StageLog,
): Promise<string> {
  const fallback = (): string => {
    const text = composeDeterministicResponse(request.decision, request.order, request.message);
    log.record('respond', 'deterministic reply (phrasing unavailable or rejected)');
    return text;
  };
  if (deps.analyzer.phrase === undefined) {
    return fallback();
  }
  const envelope = buildPhraseEnvelope(request.decision, request.order);
  const history = transcriptForOrder(db, request.customerId, orderIdFor(request.order), request.now, HISTORY_LIMIT);
  const profile = inferTone(history);
  try {
    const text = await deps.analyzer.phrase(
      {
        envelope,
        customerName: request.customerName,
        message: request.message,
        quote: request.verifiedQuotes[0] ?? null,
        history,
        style: { tone: profile.tone },
      },
      observer,
    );
    if (text !== null && isSafePhrasedReply(text, envelope)) {
      log.record('respond', 'model phrasing accepted against the envelope');
      return text;
    }
    log.record('respond', 'model phrasing rejected by envelope check; deterministic fallback');
    return fallback();
  } catch (error: unknown) {
    log.record('respond', `model phrasing unavailable (${truncate(error instanceof Error ? error.message : String(error), 80)}); deterministic fallback`);
    return fallback();
  }
}

export { DEFAULT_DISCRETION };
