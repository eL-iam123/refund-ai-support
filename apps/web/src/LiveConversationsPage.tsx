import { useEffect, useState, type ReactNode } from 'react';
import { Bot, FileText, Headset, Inbox, MessageSquare, Send, User, Scale, ShieldAlert } from 'lucide-react';
import type { RuleOutcome } from '@refund/shared';
import {
  api,
  describe,
  type HandoffBrief,
  type StaffConversation,
  type StaffThreadTurn,
} from './api';
import { formatCents, formatTime } from './format';
import { money } from './shop/api';
import { useAsyncData, Spinner } from './shop/hooks';

/**
 * The live takeover console.
 *
 * The queue a reviewer reaches by clicking "Live" is not a list of decisions -
 * those live under All requests - it is a list of *conversations*. A newcomer is
 * a customer the assistant has been talking to and cannot finish with; a
 * carrying conversation is one a colleague has already taken. Both belong here,
 * and both are the same thing in the end: a customer who would rather be talking
 * to a person, now talking to one.
 *
 * Everything the agent needs to answer is built server-side and shown above the
 * thread - the customer's own words, the assistant's restatement of them, the
 * evidence the pipeline secured, and the rules it ran - so the human is not
 * re-deriving what the machine already established.
 */
export function LiveConversationsPage(): ReactNode {
  const [selected, setSelected] = useState<StaffConversation | null>(null);
  const [version, setVersion] = useState(0);
  const conversations = useAsyncData(
    () => api.staffConversations().then((result) => result.conversations),
    ['live-list', version],
  );
  const analytics = useAsyncData(
    () => api.staffAnalytics().then((result) => result.analytics),
    ['live-analytics', version],
  );
  // Hoisted out of the console because the case file renders in the sidebar and
  // the thread in the console; one read feeds both.
  const caseFile = useAsyncData<CaseDetail | null>(
    () =>
      selected === null
        ? Promise.resolve(null)
        : api.staffConversation(selected.customerId, selected.orderId).then((result) => result),
    ['live-case', selected?.customerId ?? '', selected?.orderId ?? '', version],
  );

  useStaffConversationSocket(() => setVersion((v) => v + 1));

  /**
   * Select a conversation, or put the current one back if it is clicked again.
   *
   * Clicking the open row closes the case, which is what makes the rail feel
   * reversible: one row is both "open this" and "close this". Comparison is by
   * conversation identity, not by object, because the list is re-fetched on
   * every socket message and a fresh object for the same case arrives each time.
   */
  const toggleCase = (row: StaffConversation): void => {
    setSelected((current) =>
      current !== null && conversationKey(current) === conversationKey(row) ? null : row,
    );
  };

  return (
    <div className="admin-page">
      {/*
        No visible page heading. The topbar already shows "Live" as the active
        nav item, so a second one said it again and cost a whole row. The
        guidance it carried moved to the empty state, where an agent actually
        needs it, and the heading stays in the document for screen readers.
      */}
      <h1 className="sr-only">Live</h1>
      <div className={`live-layout ${selected === null ? 'rail-queue' : 'rail-case'}`}>
        <AnalyticsStrip analytics={analytics} />
<Rail
          conversations={conversations}
          selected={selected}
          onSelect={toggleCase}
          onClose={() => setSelected(null)}
          detail={caseFile.data}
          error={caseFile.error}
        />
        <section className="live-console">
          <ConsoleBody
            conversation={selected}
            detail={caseFile.data}
            onChanged={() => setVersion((v) => v + 1)}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * Re-read everything when the staff socket says something moved.
 *
 * The socket announces arrivals and replies but carries no bodies, on purpose:
 * the server is the only thing that can assemble a thread and a briefing
 * consistently, so the client is told there is something new and re-reads it.
 * See the comment on LiveHub for why notify-then-refetch beats pushing copies.
 */
function useStaffConversationSocket(onChange: () => void): void {
  useEffect(() => {
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/staff/conversation/ws`,
    );
    socket.onmessage = onChange;
    return () => socket.close();
  }, [onChange]);
}

/**
 * The rail: two panels, one column, one open at a time.
 *
 * Both panels are always rendered, so the rail reads as a pair of tabs rather
 * than as content that appears and vanishes. The open one is on top and fills the
 * rail; the closed one is a tab beneath it. They swap places as the selection
 * changes, so whichever panel is live is always the one at the top - the active
 * control never moves.
 */
function Rail({
  conversations,
  selected,
  onSelect,
  onClose,
  detail,
  error,
}: {
  conversations: { readonly data: readonly StaffConversation[] | null; readonly error: string | null };
  selected: StaffConversation | null;
  onSelect: (row: StaffConversation) => void;
  onClose: () => void;
  detail: CaseDetail | null;
  error: string | null;
}): ReactNode {
  // The case file does not exist until a conversation is open. There is no
  // "closed" state for it to sit in - an empty case file is not something an
  // agent needs to look at, so it is not rendered at all.
  if (selected === null || detail === null) {
    return (
      <aside className="live-rail">
        <ConversationList
          conversations={conversations}
          selected={selected}
          onSelect={onSelect}
          active
        />
      </aside>
    );
  }
  return (
    // With a case open the panels swap: the case file takes the rail's top slot
    // and the queue becomes the tab beneath it. They are in this order in the
    // markup, so the open panel is always first with no ordering rules.
    <aside className="live-rail">
      <CaseBrief brief={detail.brief} />
      <ConversationList
        conversations={conversations}
        selected={selected}
        onSelect={onSelect}
        onClose={onClose}
        active={false}
      />
      {error !== null ? <p className="error">{error}</p> : null}
    </aside>
  );
}

/**
 * What the console shows for the current selection.
 *
 * Split out so the three states - nothing chosen, chosen but still loading, and
 * chosen and loaded - read as a list rather than as nested ternaries in the
 * middle of the page layout.
 */
function ConsoleBody({
  conversation,
  detail,
  onChanged,
}: {
  conversation: StaffConversation | null;
  detail: CaseDetail | null;
  onChanged: () => void;
}): ReactNode {
  if (conversation === null) {
    return (
      // The page heading's explanation lived here rather than in a header row:
      // this is the only moment it is true, and it tells the agent what the
      // console is for at the moment they are deciding what to do with it.
      <div className="console-empty">
        <h2>No support conversation open</h2>
        <p>
          Pick a case from the queue to review the customer issue, the assistant's notes, and the
          policy outcome before responding or taking over.
        </p>
      </div>
    );
  }
  if (detail === null) {
    return <Spinner />;
  }
  return (
    <TakeoverConsole
      key={conversationKey(conversation)}
      conversation={conversation}
      thread={detail.thread}
      brief={detail.brief}
      onChanged={onChanged}
    />
  );
}

/** What the staff conversation endpoint returns for the open case. */
interface CaseDetail {
  readonly thread: readonly StaffThreadTurn[];
  readonly brief: HandoffBrief;
}

/**
 * The distinguishing tail of an order id.
 *
 * Order ids are UUIDs like `ORD-16934234-69a6-42f0-8e94-2a1e5bd32f8b`. The
 * leading groups are a timestamp and do not differ between orders from the same
 * run, so printing them is noise that costs three wrapped lines in a 270px
 * column and nothing in telling one case from another. The last two groups are
 * kept because they are what actually differs; the full id stays in the title.
 */
function shortOrder(orderId: string | null): string {
  if (orderId === null) {
    return 'No order';
  }
  const segments = orderId.split('-');
  return segments.length <= 2 ? orderId : `…${segments.slice(-2).join('-')}`;
}

/**
 * What makes one row a distinct case.
 *
 * The list is grouped server-side by customer *and* order
 * (`GROUP BY customer_id, order_id` in `db/handoffs.ts`), so one customer with
 * three orders is three rows and three separate threads. Comparing on
 * `customerId` alone therefore lit every row belonging to the customer, which
 * read as "selecting one selects all".
 *
 * Deliberately not widened with `activeHandoff.id` or `lastActivityAt`:
 * `activeHandoff` is resolved per customer, so it is identical across that
 * customer's rows and adds nothing, and `lastActivityAt` advances on every
 * message, which would make the highlight fall off the row you just clicked as
 * soon as the websocket triggered a refetch. The pair the server groups by is the
 * only stable identity the payload carries.
 */
function conversationKey(row: StaffConversation): string {
  return row.customerId + ':' + (row.orderId ?? '');
}

/**
 * Rule outcomes are `deny` / `escalate` / `approve` / `pass`; the stylesheet
 * names its pills after decisions - `pill-approved`, `pill-denied`,
 * `pill-escalated` - which is a different vocabulary. Interpolating
 * `pill-${outcome}` directly produced `pill-approve`, `pill-deny` and
 * `pill-escalate`, none of which exist, so every rule pill in the policy trail
 * rendered as unstyled grey. The mapping is explicit rather than derived so the
 * two vocabularies can drift apart without silently losing colour again.
 *
 * `pass` is the one outcome with no decision counterpart: it means a rule ran and
 * found nothing blocking, which is worth showing but is not a decision.
 */
const OUTCOME_PILL: Record<RuleOutcome, string> = {
  approve: 'pill-approved',
  deny: 'pill-denied',
  escalate: 'pill-escalated',
  pass: 'pill-pass',
};

/** What the brief's `state` means, in words an agent would say out loud. */
const STATE_TEXT: Record<HandoffBrief['state'], string> = {
  ai: 'Assistant is handling this',
  handed_off: 'A colleague has taken over',
};

/** The choose-one list: every conversation that moved in the last 24 hours. */
function ConversationList({
  conversations,
  selected,
  onSelect,
  active,
  onClose,
}: {
  conversations: { readonly data: readonly StaffConversation[] | null; readonly error: string | null };
  selected: StaffConversation | null;
  onSelect: (row: StaffConversation) => void;
  active: boolean;
  onClose?: () => void;
}): ReactNode {
  const title = (
    <span className="rail-tab-title">
      <MessageSquare size={14} aria-hidden="true" /> Conversations
    </span>
  );
  const note = conversations.data === null ? '' : `${conversations.data.length} open`;

  if (!active) {
    /*
      Minimised, the queue is a plain button and not a disclosure. As a
      `<details>` its own summary would expand the list on click while the case
      file stayed open, putting both on screen - the exact thing this rail is
      built to prevent. One control, one effect: put the case down and bring the
      queue back up.
    */
    return (
      <div className="live-panel live-panel-tab">
        <button type="button" className="rail-tab rail-tab-button" onClick={onClose}>
          {title}
          <span className="rail-tab-note">{note}</span>
        </button>
      </div>
    );
  }

  return (
    <details className="live-panel panel" open>
      <summary className="rail-tab">
        {title}
        <span className="rail-tab-note">{note}</span>
      </summary>
      <div className="panel-body">
        {conversations.error !== null ? <p className="error">{conversations.error}</p> : null}
        {renderRows(conversations.data, selected, onSelect)}
      </div>
    </details>
  );
}

function renderRows(
  rows: readonly StaffConversation[] | null,
  selected: StaffConversation | null,
  onSelect: (row: StaffConversation) => void,
): ReactNode {
  if (rows === null) {
    return <Spinner />;
  }
  if (rows.length === 0) {
    return (
      <p className="empty">
        <Inbox size={16} /> Nothing is moving. When a customer writes to the assistant, the
        conversation appears here.
      </p>
    );
  }
  return (
    <ul className="live-list-rows">
      {rows.map((row) => (
        <li key={conversationKey(row)}>
          <button
            type="button"
            className={`live-row ${selected !== null && conversationKey(selected) === conversationKey(row) ? 'is-active' : ''}`}
            onClick={() => onSelect(row)}
          >
            {/*
              Three stacked lines: name, then status, then meta. The pills used
              to sit beside the name, which squeezed the name into "Dana..." and
              forced the pills themselves to shrink. Stacked, each line has the
              full width and nothing has to abbreviate.
            */}
            <span className="live-row-name">{row.customerName}</span>
            {row.activeHandoff !== null || row.openAppeals.length > 0 ? (
              <span className="live-row-status">
                {row.activeHandoff !== null ? (
                  <span className="pill pill-escalated" title="A colleague has taken this over">taken over</span>
                ) : null}
                {row.openAppeals.length > 0 ? (
                  <span className="pill pill-denied" title={row.openAppeals.map((a) => a.reason).join('; ')}>
                    {row.openAppeals.length} appeal{row.openAppeals.length > 1 ? 's' : ''}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="live-row-meta">
              {/*
                The order id is a UUID, and at 270px it wraps onto three lines,
                which made row heights step 90 / 110 / 128 and read as ragged.
                A short form keeps every row one line and one height; the full id
                stays in the title for anyone who needs to copy it.
              */}
              <span className="live-row-order" title={row.orderId ?? undefined}>
                {shortOrder(row.orderId)}
              </span>
              <span className="live-row-count">{row.activityCount} msg</span>
              <span className="live-row-time">{formatTime(row.lastActivityAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The open case: header, thread, and the takeover verbs.
 *
 * The briefing and the thread come from the staff endpoint in one read, so two
 * agents opening the same conversation see the same case - the briefing is
 * derived, not cached, and the freshness is the point. That read is hoisted to
 * the page because the case file renders in the sidebar while the thread renders
 * here; fetching in each would issue the request twice.
 */
function TakeoverConsole({
  conversation,
  thread,
  brief,
  onChanged,
}: {
  conversation: StaffConversation;
  thread: readonly StaffThreadTurn[];
  brief: HandoffBrief;
  onChanged: () => void;
}): ReactNode {
  const [errand, setErrand] = useState<string>('');
  const active = conversation.activeHandoff;

  const run = async (verb: () => Promise<unknown>): Promise<void> => {
    setErrand('');
    try {
      await verb();
      onChanged();
    } catch (cause: unknown) {
      setErrand(describe(cause));
    }
  };

  return (
    <div className="case-viewer">
      <CaseHead
        brief={brief}
        takenOver={active !== null}
        onTakeOver={() => void run(() => api.staffTakeOver(conversation.customerId, conversation.orderId))}
        onHandBack={() => void run(() => api.staffHandBack(conversation.customerId))}
      />
      {errand.length > 0 ? <p className="error">{errand}</p> : null}
      <div className="case-thread">
        <ThreadView thread={thread} />
        {active !== null ? <Composer customerId={conversation.customerId} onSent={onChanged} /> : null}
      </div>
    </div>
  );
}

/**
 * Who this is, and the one verb that applies to it right now.
 *
 * The handoff is per customer rather than per order, so a colleague can hold the
 * thread while a different order is open. The button therefore reflects the
 * handoff, not the selected row - and `state` is spelled out in words here
 * because it is the first thing an agent needs to know before reading anything
 * else.
 */
function CaseHead({
  brief,
  takenOver,
  onTakeOver,
  onHandBack,
}: {
  brief: HandoffBrief;
  takenOver: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
}): ReactNode {
  return (
    <header className="case-head">
      <div className="case-id">
        <h2>{brief.customerName}</h2>
        {/*
          Order and state are two separate facts and read as two lines, the way
          a document lists them. They were joined by a middot on one line, which
          made the state - the thing an agent checks first - the part most likely
          to be missed.
        */}
        <dl className="case-facts">
          <div className="kv-pair">
            <dt>Order</dt>
            <dd>{brief.orderId ?? 'None yet'}</dd>
          </div>
          <div className="kv-pair">
            <dt>Status</dt>
            <dd>{STATE_TEXT[brief.state]}</dd>
          </div>
        </dl>
      </div>
      {takenOver ? (
        <button type="button" className="btn btn-secondary" onClick={onHandBack}>
          <Bot size={16} /> Hand back to the assistant
        </button>
      ) : (
        <button type="button" className="btn" onClick={onTakeOver}>
          <Headset size={16} /> Take over
        </button>
      )}
    </header>
  );
}

/**
 * The deterministic briefing every agent reads before answering.
 *
 * Collapsed by default, unlike the words and the thread beside it. The two things
 * an agent always needs are the conversation itself and any risk the pipeline
 * flagged, so those are the only parts shown before the case file is opened; the
 * rule trail is a reference an agent consults when a decision looks wrong, and
 * defaulting it open meant every reply started with a wall of `pass` before the
 * customer's actual problem.
 */
function CaseBrief({ brief }: { brief: HandoffBrief }): ReactNode {
  return (
    <details className="live-panel case-brief" open>
      <summary className="rail-tab">
        <span className="rail-tab-title">
          <FileText size={14} aria-hidden="true" /> Case file
        </span>
        <span className="rail-tab-note">{brief.customerName}</span>
      </summary>
      <div className="panel-body">
        <RiskFlags brief={brief} />
        <div className="case-columns">
          <WordsColumn brief={brief} />
          <EvidenceColumn brief={brief} />
        </div>
      </div>
    </details>
  );
}

function WordsColumn({ brief }: { brief: HandoffBrief }): ReactNode {
  return (
    <section>
      <h3>In their words</h3>
      {brief.whatTheySaid.length === 0 ? (
        <p className="muted small">Nothing on record yet.</p>
      ) : (
        <ul className="case-quotes">
          {brief.whatTheySaid.map((line) => (
            <li key={line.at}>“{line.text}”</li>
          ))}
        </ul>
      )}
      {brief.dialogue.length > 0 ? (
        <>
          <h3>What the assistant asked</h3>
          <ul className="case-dialogue">
            {brief.dialogue.map((turn) => (
              <li key={turn.question}>
                <span className="small muted">“{turn.question}”</span>
                <span>customer: “{turn.answer}”</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function EvidenceColumn({ brief }: { brief: HandoffBrief }): ReactNode {
  return (
    <section>
      <h3>Evidence confirmed</h3>
      {brief.echoedEvidence.length === 0 ? (
        <p className="muted small">Nothing was verified against the customer&apos;s own words.</p>
      ) : (
        <ul className="case-quotes">
          {brief.echoedEvidence.map((quote) => (
            <li key={quote}>“{quote}”</li>
          ))}
        </ul>
      )}

      <h3>The claim</h3>
      <ClaimLines claim={brief.claim} />
      <PolicyTrail brief={brief} />
    </section>
  );
}

function ClaimLines({ claim }: { claim: HandoffBrief['claim'] }): ReactNode {
  if (claim === null) {
    return <p className="muted small">No claim yet on this thread - the assistant may still be asking.</p>;
  }
  return (
    <dl className="kv">
      <dt>Decision</dt>
      <dd>
        <span className={`pill pill-${claim.decision}`}>{claim.decision}</span>
      </dd>
      {/*
        An escalated claim carries a proposed amount that nobody is authorised to
        pay yet, and a denied one carries zero. Printing "$0.00" against either
        reads as a decision about money rather than about the case, which is the
        one distinction this console exists to keep straight.
      */}
      <dt>Amount</dt>
      <dd>
        <PayableAmount decision={claim.decision} cents={claim.refundAmountCents} />
      </dd>
      {claim.reasonCodes.length > 0 ? (
        <>
          <dt>Reasons</dt>
          <dd className="small">{claim.reasonCodes.join(', ')}</dd>
        </>
      ) : null}
      <dt>Summary</dt>
      <dd>{claim.summary}</dd>
      {claim.items.length > 0 ? (
        <>
          <dt>Items</dt>
          <dd>{claim.items.join(', ')}</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * What the claim's amount actually means, which is not the same as the number.
 *
 * Only an approval authorises payment. An escalation carries a figure the
 * pipeline proposed and no human has approved, and a denial has nothing to pay.
 * Showing the raw figure for either invites exactly the misreading the
 * whole console is built to prevent, so both are stated in words instead.
 */
function PayableAmount({ decision, cents }: { decision: string; cents: number }): ReactNode {
  if (decision === 'approved') {
    return <>{formatCents(cents)}</>;
  }
  if (decision === 'escalated') {
    return <span className="muted">{formatCents(cents)} proposed, not payable yet</span>;
  }
  return <span className="muted">Nothing payable</span>;
}

function PolicyTrail({ brief }: { brief: HandoffBrief }): ReactNode {
  if (brief.policyTrail.length === 0) {
    return null;
  }
  const blocking = brief.policyTrail.filter((rule) => rule.outcome !== 'pass').length;
  return (
    <>
      <h3>
        <Scale size={13} aria-hidden="true" /> Rules that ran
        <span className="h3-note">
          {blocking} of {brief.policyTrail.length} decided
        </span>
      </h3>
      {/*
        Each rule is a document entry: the rule id on its own line above the
        reason it gave, rather than the pill sitting inline with the evidence and
        wrapping mid-sentence.
      */}
      <ul className="rule-lines">
        {brief.policyTrail.map((rule) => (
          <li key={rule.ruleId}>
            <span className={`pill ${OUTCOME_PILL[rule.outcome]}`}>{rule.ruleId}</span>
            <span className="rule-why">{rule.evidence}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function RiskFlags({ brief }: { brief: HandoffBrief }): ReactNode {
  if (brief.riskFlags.length === 0) {
    return null;
  }
  return (
    <div className="risks">
      {brief.riskFlags.map((flag) => (
        <div key={flag.label} className="note note-warn">
          <ShieldAlert size={16} aria-hidden="true" />
          <div>
            <p className="risk-label">
              <ShieldAlert size={12} aria-hidden="true" /> {flag.label}
            </p>
            <p className="risk-detail">{flag.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The thread, drawn as the conversation rather than as the customer saw it.
 *
 * The storefront styles a customer message as `bubble-me`, because from that
 * side the reader *is* the customer. A staff reader is the other party, so the
 * same class is wrong here: every turn is labelled with who actually spoke, and
 * the assistant's turns carry the decision they produced. The thread is capped
 * and scrolled rather than unbounded, so the reply box stays reachable on a long
 * case.
 */
function ThreadView({ thread }: { thread: readonly StaffThreadTurn[] }): ReactNode {
  if (thread.length === 0) {
    return <p className="muted small">No messages yet.</p>;
  }
  return (
    <div className="chat-log thread-stack">
      {thread.map((turn) => (
        <ThreadTurn key={turn.kind === 'request' ? turn.requestId : turn.id} turn={turn} />
      ))}
    </div>
  );
}

function ThreadTurn({ turn }: { turn: StaffThreadTurn }): ReactNode {
  switch (turn.kind) {
    case 'request':
      return <RequestTurn turn={turn} />;
    case 'dialogue':
      return <DialogueTurn turn={turn} />;
    case 'update':
      return <UpdateTurn turn={turn} />;
    case 'agent':
      return <AgentTurn turn={turn} />;
    case 'handoff':
      return <HandoffTurn turn={turn} />;
  }
}

/** The shape the staff analytics endpoint returns. */
interface QueueAnalytics {
  readonly openHandoffs: number;
  readonly escalatedAwaiting: number;
  readonly awaitingReviewCents: number;
  readonly decisionsToday: { readonly approved: number; readonly denied: number; readonly escalated: number };
  readonly averageTakeoverMinutes: number | null;
  readonly since: string;
}

/**
 * The queue snapshot at the top of the page.
 *
 * One line, read left to right, rather than four tiles spread across 1400px. The
 * tiles were `auto-fit minmax(130px, 1fr)`, so each metric sat in a column far
 * wider than its content and the row read as four disconnected figures rather
 * than one status line. Set as inline label/value pairs it becomes a single
 * sentence an agent can scan across.
 *
 * An agent opening this page has one question - how much is waiting on me - so
 * the handoffs and the escalations nobody has picked up are summed into a single
 * "waiting" figure. The rest is context.
 */
function AnalyticsStrip({
  analytics,
}: {
  analytics: { readonly data: QueueAnalytics | null; readonly error: string | null };
}): ReactNode {
  if (analytics.data === null) {
    return analytics.error !== null ? <p className="error">{analytics.error}</p> : <Spinner />;
  }
  const { openHandoffs, escalatedAwaiting, awaitingReviewCents, decisionsToday, averageTakeoverMinutes, since } =
    analytics.data;
  const total = decisionsToday.approved + decisionsToday.denied + decisionsToday.escalated;
  return (
    <aside className="live-analytics">
      <p className="queue-line">
        <span className="queue-item">
          <span className="queue-label">Waiting</span>
          <strong className="queue-value">{openHandoffs + escalatedAwaiting}</strong>
        </span>
        <span className="queue-item">
          <span className="queue-label">Needs review</span>
          <strong className="queue-value">{money(awaitingReviewCents)}</strong>
        </span>
        <span className="queue-item">
          <span className="queue-label">Decided today</span>
          <span className="queue-value">
            <span className="pill pill-approved">{decisionsToday.approved} approved</span>
            <span className="pill pill-denied">{decisionsToday.denied} denied</span>
            <span className="pill pill-escalated">{decisionsToday.escalated} escalated</span>
          </span>
        </span>
        <span className="queue-item">
          <span className="queue-label">Avg takeover</span>
          <strong className="queue-value">
            {averageTakeoverMinutes === null ? 'None yet' : `${Math.round(averageTakeoverMinutes)} min`}
          </strong>
        </span>
      </p>
      <p className="muted small">
        {total === 0 ? 'No decisions today' : `${total} decision${total === 1 ? '' : 's'} today`} · counted
        from {formatTime(since)}
      </p>
    </aside>
  );
}


/**
 * One document entry, in reading order.
 *
 * The thread keeps its chat bubbles, but the text inside them is set as a
 * document entry rather than as chat chrome: speaker and timestamp share one
 * left-aligned line, the message follows underneath at full width, and any
 * attachment or footer closes the entry. Previously the speaker sat on its own
 * line, the message below it, and the timestamp was pushed to the far right of a
 * header row - so the eye had to jump right, then back left, for every turn.
 */
function TurnHead({
  children,
  at,
}: {
  children: ReactNode;
  at: string;
}): ReactNode {
  return (
    <header className="turn-head">
      <span className="who">{children}</span>
      <span className="when">{formatTime(at)}</span>
    </header>
  );
}

function RequestTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'request' }> }): ReactNode {
  return (
    <>
      <div className="bubble-me">
        <TurnHead at={turn.createdAt}>
          <User size={13} aria-hidden="true" /> Customer
        </TurnHead>
        <p>{turn.message}</p>
      </div>
      <div className="bubble-them">
        <TurnHead at={turn.createdAt}>
          <Bot size={14} aria-hidden="true" /> Assistant
        </TurnHead>
        <p className="turn-verdict">
          <span className={`pill pill-${turn.decision}`}>{turn.decision}</span>
        </p>
        <p>{turn.responseText}</p>
        {/*
          Only an approval authorises money. The old `!== 'denied'` test printed
          "$0.00" under every escalation, which is the exact figure a reader
          should never take away from an escalated case.
        */}
        {turn.decision === 'approved' ? (
          <footer className="turn-foot">{formatCents(turn.refundAmountCents)} authorised</footer>
        ) : null}
      </div>
    </>
  );
}

function DialogueTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'dialogue' }> }): ReactNode {
  return (
    <>
      <div className="bubble-me">
        <TurnHead at={turn.createdAt}>
          <User size={13} aria-hidden="true" /> Customer
        </TurnHead>
        <p>{turn.message}</p>
      </div>
      <div className="bubble-them">
        <TurnHead at={turn.createdAt}>
          <Bot size={14} aria-hidden="true" /> Assistant asked
        </TurnHead>
        <p>{turn.question}</p>
      </div>
    </>
  );
}

function UpdateTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'update' }> }): ReactNode {
  return (
    <div className="bubble-them">
      <TurnHead at={turn.createdAt}>
        <span className="pill pill-escalated">Reviewed by a person</span>
      </TurnHead>
      <p>{turn.body}</p>
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'agent' }> }): ReactNode {
  if (turn.sender === 'customer') {
    return (
      <div className="bubble-me">
        <TurnHead at={turn.createdAt}>
          <User size={13} aria-hidden="true" /> Customer
        </TurnHead>
        <p>{turn.body}</p>
        {/*
          Truthiness, not `!== null`: the declared type is `| null` but the wire
          omits the key entirely on a text message, so `undefined` reaches here
          too and a strict null check dereferenced it and took the whole page
          down. This also avoids rendering a literal `0` into the DOM, which is
          what `media && ...` did when the key was present but null.
        */}
        {turn.media ? <img src={turn.media.url} alt="Photo sent by the customer" className="chat-media" /> : null}
      </div>
    );
  }
  return (
    <div className="bubble-them bubble-agent">
      <TurnHead at={turn.createdAt}>
        <Headset size={13} aria-hidden="true" /> Customer agent
      </TurnHead>
      <p>{turn.body}</p>
      {turn.media ? <img src={turn.media.url} alt="Photo sent by the agent" className="chat-media" /> : null}
    </div>
  );
}

function HandoffTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'handoff' }> }): ReactNode {
  return (
    <div className="bubble-them handoff-turn">
      <span className="when">{formatTime(turn.createdAt)}</span>
      <p>{turn.body}</p>
    </div>
  );
}

function handleAttachPhoto(
  customerId: string,
  draft: string,
  onSent: () => void,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
  setError: React.Dispatch<React.SetStateAction<string>>,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/gif,image/webp';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be at most 5 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      try {
        await api.staffMessage(customerId, draft, dataUrl);
        setDraft('');
        onSent();
      } catch (cause) {
        setError(describe(cause));
      }
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function sendMessage(
  customerId: string,
  body: string,
  onSent: () => void,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setError: React.Dispatch<React.SetStateAction<string>>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): Promise<void> {
  setBusy(true);
  setError('');
  try {
    await api.staffMessage(customerId, body);
    setDraft('');
    onSent();
  } catch (cause: unknown) {
    setError(describe(cause));
  } finally {
    setBusy(false);
  }
}

/** The reply box, visible only while this agent has the thread. */
function Composer({ customerId, onSent }: { customerId: string; onSent: () => void }): ReactNode {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const body = draft.trim();
        if (body.length > 0 && !busy) {
          void sendMessage(customerId, body, onSent, setBusy, setError, setDraft);
        }
      }}
    >
      <input
        value={draft}
        maxLength={4000}
        aria-label="Reply to the customer"
        placeholder="Reply to the customer…"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        disabled={busy}
        aria-label="Attach a photo"
        onClick={() => handleAttachPhoto(customerId, draft, onSent, setDraft, setError)}
        className="composer-photo"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      </button>
      <button type="submit" disabled={busy} aria-label="Send">
        <Send size={16} />
        <span className="sr-only">Send</span>
      </button>
      {error.length > 0 ? <p className="error small">{error}</p> : null}
    </form>
  );
}