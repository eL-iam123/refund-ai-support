import type { Db } from '../db/connection.js';
import { activeHandoffForCustomer, type ActiveHandoff } from '../db/handoffs.js';
import { latestRequestForThread } from '../db/requestRepository.js';
import type { PersistedRequest } from '../db/records.js';
import { threadForStaff, type ChatTurn } from '../retrieval/conversation.js';
import type { ClaimExtractionDto, GroundingDto, RuleEvaluationDto } from '@refund/shared';
import { chatClosureForThread, finalizedRequestId } from '../db/chatClosures.js';

/**
 * The case file a person reads before answering a customer.
 *
 * A takeover hands the customer to a human who was not in the room for the
 * automatic part. That human needs one page that says, in order: who this is,
 * what they are asking about, what the assistant established, what the policy
 * machinery concluded, and what the customer's own words (the only ground truth
 * there is) actually support. That page is built deterministically, from stored
 * rows only - no model call, no live inference - so two people opening the same
 * conversation see the same briefing, and the briefing cannot disagree with the
 * thread it sits beside.
 *
 * The 'restatement' one can point to is the assistant's own questions: in the
 * ask-first flow the assistant is told to show it understood before asking
 * ("Just to be sure I've got it right, ..."), so the dialogue record is also the
 * record of the complaint being translated into something coherent.
 */
export interface HandoffBrief {
  readonly state: 'ai' | 'handed_off';
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  /** Who is on the line, when a takeover is live. */
  readonly agentId: string | null;
  /**
   * True while a takeover is live but no person has claimed it. `state` alone
   * cannot say this: it is `handed_off` for both the automatic escalation marker
   * and a real agent, and the console must not offer a reply box for the former.
   */
  readonly unattended: boolean;
  readonly since: string | null;
  readonly chatClosed: { readonly closedAt: string; readonly closedBy: string; readonly requestId: string } | null;
  readonly canCloseChat: boolean;
  /** Why the assistant stepped aside, when it did. */
  readonly handoffReason: string | null;
  /** The customer's words, in order, verbatim. */
  readonly whatTheySaid: readonly { readonly at: string; readonly text: string }[];
  /** The assistant's restatements/questions and the answers they drew out. */
  readonly dialogue: readonly { readonly question: string; readonly answer: string }[];
  /** What the assistant has secured as the customer's own words, evidence-checked. */
  readonly echoedEvidence: readonly string[];
  /** The claim machinery concluded, if a claim was ever produced. */
  readonly claim:
    | {
        readonly summary: string;
        readonly decision: string;
        readonly refundAmountCents: number;
        readonly reasonCodes: readonly string[];
        readonly items: readonly string[];
      }
    | null;
  /** The rules that decided, in order, with their reasons. */
  readonly policyTrail: readonly {
    readonly ruleId: string;
    readonly outcome: string;
    readonly evidence: string;
  }[];
  readonly riskFlags: readonly { readonly label: string; readonly detail: string }[];
}

export function buildHandoffBrief(db: Db, customerId: string, orderId: string | null): HandoffBrief {
  const nameRow = db
    .prepare('SELECT name FROM customers WHERE id = ?')
    .get(customerId) as { readonly name: string } | undefined;

  const active = activeHandoffForCustomer(db, customerId);
  const thread = threadForStaff(db, customerId, orderId, 200);
  const latest = latestRequestForThread(db, customerId, orderId);
  const latestView = latest === null ? null : decodeLatest(latest);
  const closure = chatClosureForThread(db, customerId, orderId);
  const canCloseChat = closure === null && finalizedRequestId(db, customerId, orderId) !== null;

  const conversation = collectCase(thread);

  return {
    state: stateFor(active),
    customerId,
    customerName: customerNameFor(nameRow),
    orderId,
    agentId: agentIdFor(active),
    unattended: active?.unattended ?? false,
    since: sinceFor(active),
    chatClosed: closure === null ? null : { closedAt: closure.closedAt, closedBy: closure.closedBy, requestId: closure.requestId },
    canCloseChat,
    handoffReason: handoffReasonFor(active, latest),
    whatTheySaid: conversation.whatTheySaid,
    dialogue: conversation.dialogue,
    echoedEvidence: echoedEvidenceFor(latestView),
    claim: claimFor(latestView),
    policyTrail: policyTrailFor(latestView),
    riskFlags: riskFlagsFor(conversation.asked, latestView),
  };
}

function stateFor(active: ActiveHandoff | null): HandoffBrief['state'] {
  return active === null ? 'ai' : 'handed_off';
}

function customerNameFor(nameRow: { readonly name: string } | undefined): string {
  return nameRow?.name ?? 'Unknown customer';
}

function agentIdFor(active: ActiveHandoff | null): string | null {
  return active?.agentId ?? null;
}

function sinceFor(active: ActiveHandoff | null): string | null {
  return active?.startedAt ?? null;
}

function echoedEvidenceFor(latestView: LatestView | null): readonly string[] {
  return latestView?.grounding?.verifiedQuotes ?? [];
}

function claimFor(latestView: LatestView | null): HandoffBrief['claim'] {
  return latestView === null ? null : claimFrom(latestView);
}

function policyTrailFor(latestView: LatestView | null): HandoffBrief['policyTrail'] {
  return latestView === null ? [] : policyTrailFrom(latestView);
}

/** The customer's own words and the asks that drew them out, from the thread. */
function collectCase(thread: readonly ChatTurn[]): {
  readonly whatTheySaid: readonly { readonly at: string; readonly text: string }[];
  readonly dialogue: readonly { readonly question: string; readonly answer: string }[];
  readonly asked: readonly string[];
} {
  const whatTheySaid: { readonly at: string; readonly text: string }[] = [];
  const dialogue: { readonly question: string; readonly answer: string }[] = [];
  const asked: string[] = [];
  for (const turn of thread) {
    switch (turn.kind) {
      case 'request':
        whatTheySaid.push({ at: turn.createdAt, text: turn.message });
        break;
      case 'dialogue':
        whatTheySaid.push({ at: turn.createdAt, text: turn.message });
        dialogue.push({ question: turn.question, answer: turn.message });
        asked.push(turn.question);
        break;
      case 'agent':
        if (turn.sender === 'customer') {
          whatTheySaid.push({ at: turn.createdAt, text: turn.body });
        }
        break;
      case 'update':
      case 'handoff':
        break;
    }
  }
  return { whatTheySaid, dialogue, asked };
}

/** Why the assistant stepped aside, told to a human who arrived afterwards. */
function handoffReasonFor(active: ActiveHandoff | null, latest: PersistedRequest | null): string | null {
  if (active === null) {
    return null;
  }
  return latest === null
    ? 'The assistant stepped aside without ever producing a claim on this thread.'
    : 'The thread needed a person and the assistant stepped aside.';
}

function riskFlagsFor(
  asked: readonly string[],
  latestView: LatestView | null,
): readonly { readonly label: string; readonly detail: string }[] {
  const riskFlags: { label: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const question of asked) {
    if (seen.has(question)) {
      riskFlags.push({
        label: 'Question went round twice',
        detail: `The assistant asked the same thing more than once (e.g. ${JSON.stringify(question)}); the customer may not have been able to answer, or the answer never reached a decision.`,
      });
      break;
    }
    seen.add(question);
  }

  if (latestView !== null && latestView.injection.detected) {
    riskFlags.push({
      label: 'Reply injected by the customer',
      detail: latestView.injection.matchedTexts.join('; '),
    });
  }

  return riskFlags;
}

function claimFrom(latestView: LatestView): HandoffBrief['claim'] {
  return {
    summary: latestView.summary,
    decision: latestView.decision,
    refundAmountCents: latestView.refundAmountCents,
    reasonCodes: latestView.trace
      .filter((entry) => entry.outcome !== 'pass')
      .map((entry) => entry.ruleId),
    items: latestView.extraction?.items ?? [],
  };
}

function policyTrailFrom(latestView: LatestView): HandoffBrief['policyTrail'] {
  return latestView.trace
    .filter((entry) => entry.outcome !== 'pass')
    .map((entry) => ({ ruleId: entry.ruleId, outcome: entry.outcome, evidence: entry.evidence }));
}

interface LatestView {
  readonly summary: string;
  readonly decision: string;
  readonly refundAmountCents: number;
  readonly extraction: ClaimExtractionDto | null;
  readonly grounding: GroundingDto | null;
  readonly injection: { readonly detected: boolean; readonly matchedTexts: readonly string[] };
  readonly trace: readonly RuleEvaluationDto[];
}

/**
 * Decodes the heavy columns once, with the same loud-on-corrupt parse the DTO
 * serializer uses for the admin drawer - one corrupt column would otherwise say
 * nothing in one place and crash in the other.
 */
function decodeLatest(request: PersistedRequest): LatestView {
  const injection = decode<{ detected: boolean; signals: readonly { matchedText: string }[] }>(
    request.injectionJson,
    'injection_json',
  );
  return {
    summary: request.summary,
    decision: request.decision,
    refundAmountCents: request.refundAmountCents,
    extraction: decodeNullable<ClaimExtractionDto>(request.extractionJson, 'extraction_json'),
    grounding: decodeNullable<GroundingDto>(request.groundingJson, 'grounding_json'),
    injection: {
      detected: injection.detected,
      matchedTexts: injection.signals.map((signal) => signal.matchedText),
    },
    trace: decode<RuleEvaluationDto[]>(request.traceJson, 'trace_json'),
  };
}

function decode<T>(raw: string, column: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`corrupt ${column} column: ${raw.slice(0, 120)}`, { cause });
  }
}

function decodeNullable<T>(raw: string | null, column: string): T | null {
  return raw === null ? null : decode<T>(raw, column);
}