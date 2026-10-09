import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, FileText, Headset, Inbox, MessageSquare, Send, User, Scale, ShieldAlert } from 'lucide-react';
import { AWAITING_AGENT_ID, type Decision, type RuleOutcome } from '@refund/shared';
import {
  api,
  describe,
  type ExchangeDto,
  type HandoffBrief,
  type StaffConversation,
  type StaffOrderLineDto,
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
  // Which conversation is open, by identity. Deliberately not the row itself: the
  // list is re-fetched after every action and on every socket message, and a stored
  // object is a snapshot that no refresh can update - so the case header would keep
  // rendering the state from before the agent clicked, which is how "Take over"
  // stayed on the button after it had worked.
  const [open, setOpen] = useState<StaffConversation | null>(null);
  const [version, setVersion] = useState(0);
  const conversations = useAsyncData(
    () => api.staffConversations().then((result) => result.conversations),
    ['live-list', version],
  );
  const analytics = useAsyncData(
    () => api.staffAnalytics().then((result) => result.analytics),
    ['live-analytics', version],
  );
  // Hoisted out of the console because the case file renders above the thread
  // while the thread renders below it; one read feeds both.
  const [forkOnly, setForkOnly] = useState(false);
  const { selected, forkHandoffId } = useOpenCase(open, conversations.data, forkOnly);
  const caseFile = useOpenCaseFile(open, forkHandoffId, version);

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
    const key = conversationKey(row);
    setOpen((current) => (current !== null && conversationKey(current) === key ? null : row));
    // A new case starts on the whole thread: the fork view is a focus the agent
    // chose for the previous case, not a property of this one.
    setForkOnly(false);
  };

  return (
    <div className="admin-page live-page">
      <header className="live-page-heading">
        <h1>Live conversations</h1>
        <Link to="/admin/requests">View all request history <span aria-hidden="true">↗</span></Link>
      </header>
      <div className="live-layout">
        <AnalyticsStrip analytics={analytics} />
<Rail
          conversations={conversations}
          selected={selected}
          onSelect={toggleCase}
        />
        <section className="live-console">
          <ConsoleBody
            conversation={selected}
            detail={caseFile.data}
            error={caseFile.error}
            forkScope={selected?.forkScope ?? null}
            forkOnly={forkOnly}
            onForkOnly={setForkOnly}
            onChanged={() => setVersion((v) => v + 1)}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * The open case, re-derived from the live list on every render.
 *
 * The live row, read from the newest list rather than remembered - this is the
 * one place the staleness showed, because the header's verbs come from it. A
 * row that has gone from the list (the thread closed) leaves the case open on
 * the case file, which is still readable, so the selection falls back to
 * "open, no handoff".
 *
 * Also resolves which fork the console reads when focused: the handoff id
 * comes from the live list row rather than the open case, because the row
 * refetches on every socket message, so a fork claimed after the case was
 * opened still resolves to the takeover that actually holds it.
 */
function useOpenCase(
  open: StaffConversation | null,
  rows: readonly StaffConversation[] | null,
  forkOnly: boolean,
): { selected: StaffConversation | null; forkHandoffId: string | null } {
  if (open === null) {
    return { selected: null, forkHandoffId: null };
  }
  const selected =
    rows?.find((row) => row.customerId === open.customerId && row.orderId === open.orderId) ??
    // The row is gone from the list - the thread closed between clicks. The case
    // file is still readable, so the case stays open with no handoff.
    { ...open, activeHandoff: null };
  const liveHandoff = selected.activeHandoff;
  const forkHandoffId =
    forkOnly && liveHandoff !== null && !isUnattended(liveHandoff) ? liveHandoff.id : null;
  return { selected, forkHandoffId };
}

/** The open case's thread and brief, in the console's chosen scope. */
function useOpenCaseFile(
  open: StaffConversation | null,
  forkHandoffId: string | null,
  version: number,
): { data: CaseDetail | null; error: string | null; reload: () => void } {
  return useAsyncData<CaseDetail | null>(
    () =>
      open === null
        ? Promise.resolve(null)
        : api
            .staffConversation(open.customerId, open.orderId, forkHandoffId ?? undefined)
            .then((result) => result),
    ['live-case', open?.customerId ?? '', open?.orderId ?? '', forkHandoffId ?? '', version],
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
  // Pinned in a ref: the caller passes an inline closure, so depending on its
  // identity would tear the socket down and rebuild it on every render - a
  // connect/close storm in which any message arriving mid-churn is lost, which
  // is exactly how a reply lands in storage yet never on screen until refresh.
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/staff/conversation/ws`,
    );
    socket.onmessage = () => handler.current();
    return () => socket.close();
  }, []);
}

/**
 * The rail: the queue, always fully visible.
 *
 * It used to trade places with the case file - one open at a time - back when
 * both lived in this column and competed for it. The file now sits above the
 * thread in the console column, so the queue has nothing to compete with and
 * stays open: an agent switching cases should not have to reopen the list
 * between every two clicks.
 */
function Rail({
  conversations,
  selected,
  onSelect,
}: {
  conversations: { readonly data: readonly StaffConversation[] | null; readonly error: string | null };
  selected: StaffConversation | null;
  onSelect: (row: StaffConversation) => void;
}): ReactNode {
  return (
    <aside className="live-rail">
      <ConversationList conversations={conversations} selected={selected} onSelect={onSelect} />
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
  error,
  forkScope,
  forkOnly,
  onForkOnly,
  onChanged,
}: {
  conversation: StaffConversation | null;
  detail: CaseDetail | null;
  error: string | null;
  forkScope: StaffConversation['forkScope'];
  forkOnly: boolean;
  onForkOnly: (only: boolean) => void;
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
    // A failed read is stated, not spun on: the rail used to carry this error
    // beside the queue, and the console carrying it keeps it next to the case
    // it belongs to.
    return error === null ? <Spinner /> : <p className="error">{error}</p>;
  }
  // The file above the thread: the briefing is what the agent reads before
  // answering, so it sits directly over the conversation instead of across
  // the page from it.
  return (
    <>
      <TakeoverConsole
        key={conversationKey(conversation)}
        conversation={conversation}
        thread={detail.thread}
        brief={detail.brief}
        forkScope={forkScope}
        forkOnly={forkOnly}
        onForkOnly={onForkOnly}
        onChanged={onChanged}
      />
      <CaseBrief brief={detail.brief} />
      <ActionsPanel brief={detail.brief} />
    </>
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

/**
 * What the brief's `state` means, in words an agent would say out loud.
 *
 * `state` is only `ai` or `handed_off`, and `handed_off` covers both an escalated
 * thread nobody owns yet and one a colleague holds. `unattended` is what tells
 * them apart, so the one line an agent reads first does not claim a colleague is
 * on a case that is in fact still waiting for one.
 */
function stateText(brief: HandoffBrief): string {
  if (brief.state === 'ai') {
    return 'Assistant is handling this';
  }
  return isUnattended(brief) ? 'Waiting for a person to pick this up' : 'A colleague has taken over';
}

/** The choose-one list: every conversation that moved in the last 24 hours. */
function ConversationList({
  conversations,
  selected,
  onSelect,
}: {
  conversations: { readonly data: readonly StaffConversation[] | null; readonly error: string | null };
  selected: StaffConversation | null;
  onSelect: (row: StaffConversation) => void;
}): ReactNode {
  const title = (
    <span className="rail-tab-title">
      <MessageSquare size={14} aria-hidden="true" /> Conversations
    </span>
  );
  const note = conversations.data === null ? '' : `${conversations.data.length} open`;

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

/**
 * Whether a live handoff is still waiting for a person.
 *
 * The server sends `unattended`, but falling back to the `awaiting-agent` id
 * keeps the console honest against a server that predates the flag: without the
 * fallback the field is `undefined`, `!undefined` is true, and every waiting
 * escalation silently reverts to showing a reply box it will refuse.
 */
function isUnattended(handoff: {
  readonly agentId: string | null;
  readonly unattended?: boolean;
}): boolean {
  return handoff.unattended ?? handoff.agentId === AWAITING_AGENT_ID;
}

/**
 * The handoff pill: "waiting" while nobody has claimed the escalated thread,
 * "taken over" once a colleague actually holds it. Flattening both to
 * "taken over" told every agent a case was being handled when it was still
 * sitting in the queue for one.
 */
function HandoffPill({ handoff }: { handoff: NonNullable<StaffConversation['activeHandoff']> }): ReactNode {
  if (isUnattended(handoff)) {
    return (
      <span className="pill pill-escalated" title="Waiting for a person to pick this up">
        waiting
      </span>
    );
  }
  return (
    <span className="pill pill-escalated" title="A colleague has taken this over">
      taken over
    </span>
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
                {row.activeHandoff !== null ? <HandoffPill handoff={row.activeHandoff} /> : null}
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
            {row.forkScope !== null ? <ForkScopeLine scope={row.forkScope} /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Which case a row's takeover is the human side of.
 *
 * A customer with one escalation on one order and questions on another is one
 * row per order, but a single takeover - without this line every row reads as
 * the agent's case, and the agent opens the wrong thread first.
 */
function ForkScopeLine({ scope }: { scope: NonNullable<StaffConversation['forkScope']> }): ReactNode {
  const count = scope.itemIds.length;
  return (
    <span className="live-row-meta">
      <span className="live-row-fork" title={`Forked from case on ${scope.itemIds.join(', ')}`}>
        case: {count} item{count === 1 ? '' : 's'}
      </span>
    </span>
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
  forkScope,
  forkOnly,
  onForkOnly,
  onChanged,
}: {
  conversation: StaffConversation;
  thread: readonly StaffThreadTurn[];
  brief: HandoffBrief;
  forkScope: StaffConversation['forkScope'];
  forkOnly: boolean;
  onForkOnly: (only: boolean) => void;
  onChanged: () => void;
}): ReactNode {
  const [errand, setErrand] = useState<string>('');
  const active = conversation.activeHandoff;
  // An escalation raises a takeover before any person claims it. Treating that
  // marker as "a colleague has taken over" showed the hand-back button and the
  // reply box to every agent, and both verbs then refused with "claim this
  // conversation before replying". Only a claimed takeover is actually held.
  const takenOver = active !== null && !isUnattended(active);

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
        takenOver={takenOver}
        onTakeOver={() => void run(() => api.staffTakeOver(conversation.customerId, conversation.orderId))}
        onHandBack={() => void run(() => api.staffHandBack(conversation.customerId, conversation.orderId))}
        onClose={() => void run(() => api.staffCloseChat(conversation.customerId, conversation.orderId))}
      />
      {errand.length > 0 ? <p className="error">{errand}</p> : null}
      <div className="case-thread">
        {forkScope !== null ? (
          <ForkViewToggle scope={forkScope} forkOnly={forkOnly} onForkOnly={onForkOnly} />
        ) : null}
        <ThreadView thread={thread} />
        {takenOver ? <Composer customerId={conversation.customerId} orderId={conversation.orderId} onSent={onChanged} /> : null}
      </div>
    </div>
  );
}

/**
 * Which slice of the order thread the console reads.
 *
 * A fork answers one case, but the order thread holds everything: the case the
 * fork was split from, other cases, small talk. "This case" narrows the human
 * back-and-forth to the fork's own thread while the decided case around it
 * stays; "whole thread" is the unfiltered read for when the customer is clearly
 * talking about something else too. Defaults to the whole thread, because a
 * focus the console chose silently would hide messages an agent should see.
 */
function ForkViewToggle({
  scope,
  forkOnly,
  onForkOnly,
}: {
  scope: NonNullable<StaffConversation['forkScope']>;
  forkOnly: boolean;
  onForkOnly: (only: boolean) => void;
}): ReactNode {
  const count = scope.itemIds.length;
  return (
    <div className="row" role="group" aria-label="Thread scope">
      <span className="muted small">
        Case: {count} item{count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className={forkOnly ? 'chip chip-active' : 'chip'}
        aria-pressed={forkOnly}
        disabled={forkOnly}
        onClick={() => onForkOnly(true)}
      >
        This case
      </button>
      <button
        type="button"
        className={forkOnly ? 'chip' : 'chip chip-active'}
        aria-pressed={!forkOnly}
        disabled={!forkOnly}
        onClick={() => onForkOnly(false)}
      >
        Whole thread
      </button>
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
  onClose,
}: {
  brief: HandoffBrief;
  takenOver: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
  onClose: () => void;
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
            <dd>{stateText(brief)}</dd>
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
      {/*
        Closing is permanent: the thread locks and the composer with it. It is
        offered beside the handoff verbs rather than hidden behind them,
        because a resolved case with no close button stays open forever - and
        the server still refuses threads that owe the customer something, so a
        premature click fails loudly with the reason instead of closing.
      */}
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Close ticket
      </button>
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

/**
 * The building verbs: what the agent on a case can do to the goods behind it.
 *
 * A return is goods travelling back, an exchange is goods coming back and a
 * replacement going out, and a full refund is money reserved against the decided
 * request. They are offered here, beside the case file, from the brief's own ids
 * and a single order read - the ledgers confirm the rest server-side, and
 * nothing this panel does pays the customer: every outcome still has a person
 * between it and the purse.
 */
function ActionsPanel({ brief }: { brief: HandoffBrief }): ReactNode {
  const customerId = brief.customerId;
  const orderId = brief.orderId;
  const order = useAsyncData(
    () => (orderId === null ? Promise.resolve(null) : api.staffOrder(customerId, orderId)),
    [customerId, orderId],
  );
  const existing = useAsyncData(
    () =>
      orderId === null
        ? Promise.resolve({ exchanges: [] as readonly ExchangeDto[] })
        : api.listStaffExchanges({ orderId, customerId }),
    [customerId, orderId],
  );

  if (orderId === null) {
    return (
      <ActionsShell note="none enabled">
        <p className="muted small">No order on this case, so there is nothing to open a return, exchange or refund against.</p>
      </ActionsShell>
    );
  }
  if (order.error !== null) {
    return (
      <ActionsShell note="unavailable">
        <p className="error">{order.error}</p>
      </ActionsShell>
    );
  }
  if (order.data === null) {
    return (
      <ActionsShell note="loading">
        <Spinner />
      </ActionsShell>
    );
  }

  return (
    <ActionsShell note="return · exchange · refund">
      {existing.data !== null && existing.data.exchanges.length > 0 ? (
        <ExchangeStatusRow exchanges={existing.data.exchanges} />
      ) : null}
      <FullRefundAction brief={brief} totalCents={order.data.order.totalCents} />
      <ActionsForm brief={brief} orderId={orderId} items={order.data.order.items} />
    </ActionsShell>
  );
}

/** The folding panel every state of the actions console shares. */
function ActionsShell({ note, children }: { note: string; children: ReactNode }): ReactNode {
  return (
    <details className="live-panel case-brief">
      <summary className="rail-tab">
        <span className="rail-tab-title">
          <Scale size={14} aria-hidden="true" /> Actions
        </span>
        <span className="rail-tab-note">{note}</span>
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}

/** Any exchange already moving on this order, so the agent does not open a second one. */
function ExchangeStatusRow({ exchanges }: { exchanges: readonly ExchangeDto[] }): ReactNode {
  return (
    <section className="actions-block">
      <h4>Exchange in motion</h4>
      <ul className="action-lines">
        {exchanges.map((exchange) => (
          <li key={exchange.id}>
            <span className="chip">{exchange.status}</span>
            {exchange.labelUrl !== null ? <span className="muted small">label ready</span> : null}
            {exchange.trackingNumber !== null ? <span className="muted small">tracking {exchange.trackingNumber}</span> : null}
            {exchange.replacementSentAt !== null ? <span className="muted small">replacement sent</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The money verb. Approving is deciding the refund is owed; this reserves an
 * amount against the decided request so the purse can act. The reservation
 * lands in `pending_verification` and a person still checks it - the console
 * never reaches the purse on its own.
 */
function FullRefundAction({ brief, totalCents }: { brief: HandoffBrief; totalCents: number }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const requestId = brief.requestId;

  const run = async (): Promise<void> => {
    if (requestId === null) return;
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const { refund } = await api.authoriseFullRefund(requestId);
      setNotice(`${formatCents(refund.amountCents)} reserved on ${refund.id} · ${refund.status}, awaiting a person to check`);
    } catch (cause: unknown) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="actions-block">
      <h4>Full refund</h4>
      {requestId === null ? (
        <p className="muted small">No decided request on this case, so there is nothing to reserve money against.</p>
      ) : (
        <>
          <button type="button" className="chip chip-active" disabled={busy} onClick={() => void run()}>
            {busy ? 'Reserving…' : `Reserve full refund · ${formatCents(totalCents)}`}
          </button>
          <p className="muted small">Creates a pending_verification reservation for the whole order; a person still checks it before payment.</p>
        </>
      )}
      {error.length > 0 ? <p className="error">{error}</p> : null}
      {notice !== null ? <p className="ok-note">{notice}</p> : null}
    </section>
  );
}

/** Toggle an order line into or out of the build, carrying its quantity with it. */
function toggleSelection(prev: Readonly<Record<string, number>>, id: string): Record<string, number> {
  const next = { ...prev };
  if ((next[id] ?? 0) > 0) {
    delete next[id];
  } else {
    next[id] = 1;
  }
  return next;
}

/** Clamp a line's quantity to a sane entry range; the order's own cap is enforced server-side. */
function rewriteQuantity(
  prev: Readonly<Record<string, number>>,
  id: string,
  quantity: number,
): Record<string, number> {
  return { ...prev, [id]: Math.max(1, Math.min(99, quantity)) };
}

/**
 * The goods verbs, as one picker: a return and an exchange differ in what
 * happens after the parcel comes back, so the agent chooses the lines first and
 * the kind second.
 */
function ActionsForm({
  brief,
  orderId,
  items,
}: {
  brief: HandoffBrief;
  orderId: string;
  items: readonly StaffOrderLineDto[];
}): ReactNode {
  const [mode, setMode] = useState<'return' | 'exchange'>('exchange');
  const [chosen, setChosen] = useState<Readonly<Record<string, number>>>({});
  const [reason, setReason] = useState('');
  const [replacementNote, setReplacementNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const toggleLine = (id: string): void => setChosen((prev) => toggleSelection(prev, id));
  const setQuantity = (id: string, quantity: number): void => setChosen((prev) => rewriteQuantity(prev, id, quantity));

  const selectedLines = items
    .filter((line) => (chosen[line.id] ?? 0) > 0)
    .map((line) => ({ itemId: line.id, quantity: chosen[line.id] ?? 1 }));
  const reasoning = reason.trim();
  const canSubmit = !busy && selectedLines.length > 0 && reasoning.length > 0;
  const body = { orderId, customerId: brief.customerId, items: selectedLines, reason: reasoning };
  const reasonRequired = reasoning.length === 0;

  const submit = (): void => {
    setBusy(true);
    setError('');
    setNotice(null);
    void openBuild(mode, body, brief.requestId, replacementNote)
      .then(setNotice)
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="actions-block">
      <h4>Return or exchange</h4>
      <KindToggle mode={mode} onMode={setMode} />
      <LinePicker items={items} chosen={chosen} onToggle={toggleLine} onQuantity={setQuantity} />
      <BuildFields
        mode={mode}
        reason={reason}
        replacementNote={replacementNote}
        reasonHint={reasonRequired && selectedLines.length > 0}
        onReason={setReason}
        onReplacementNote={setReplacementNote}
      />
      <button type="button" className="chip chip-active" disabled={!canSubmit} onClick={submit}>
        {busy ? 'Opening…' : 'Open'}
      </button>
      {error.length > 0 ? <p className="error">{error}</p> : null}
      {notice !== null ? <p className="ok-note">{notice}</p> : null}
    </section>
  );
}

/** The two free-text fields; the replacement note exists only for the exchange. */
function BuildFields({
  mode,
  reason,
  reasonHint,
  replacementNote,
  onReason,
  onReplacementNote,
}: {
  mode: 'return' | 'exchange';
  reason: string;
  reasonHint: boolean;
  replacementNote: string;
  onReason: (value: string) => void;
  onReplacementNote: (value: string) => void;
}): ReactNode {
  return (
    <>
      <label className="actions-field">
        Reason
        <textarea value={reason} onChange={(event) => onReason(event.target.value)} placeholder={`Why this ${mode}? Shown on the case file.`} />
        {reasonHint ? <span className="muted small">Say why, so the file shows the intent.</span> : null}
      </label>
      {mode === 'exchange' ? (
        <label className="actions-field">
          Note on the replacement
          <input value={replacementNote} onChange={(event) => onReplacementNote(event.target.value)} placeholder="Optional — e.g. ship in the same colour" />
        </label>
      ) : null}
    </>
  );
}

/** The two kinds share a picker; the kind chosen changes only the ledger it lands in. */
function KindToggle({
  mode,
  onMode,
}: {
  mode: 'return' | 'exchange';
  onMode: (mode: 'return' | 'exchange') => void;
}): ReactNode {
  const kinds = [
    { kind: 'exchange' as const, label: 'Exchange' },
    { kind: 'return' as const, label: 'Return' },
  ];
  return (
    <div className="row" role="group" aria-label="Build kind">
      {kinds.map((candidate) => (
        <button
          key={candidate.kind}
          type="button"
          className={mode === candidate.kind ? 'chip chip-active' : 'chip'}
          aria-pressed={mode === candidate.kind}
          onClick={() => onMode(candidate.kind)}
        >
          {candidate.label}
        </button>
      ))}
    </div>
  );
}

interface BuildBody {
  readonly orderId: string;
  readonly customerId: string;
  readonly items: readonly { readonly itemId: string; readonly quantity: number }[];
  readonly reason: string;
}

/** Run the ledger verb, tripping the exact `requestId` form when the case is linked. */
async function openBuild(
  mode: 'return' | 'exchange',
  body: BuildBody,
  requestId: string | null,
  replacementNote: string,
): Promise<string> {
  if (mode === 'return') {
    const { return: made } = await api.createStaffReturn(requestId === null ? body : { ...body, requestId });
    return `Return ${made.id} opened · ${made.status}`;
  }
  const linked = requestId === null ? body : { ...body, requestId };
  const note = replacementNote.trim();
  const { exchange: made } = await api.createStaffExchange(note.length > 0 ? { ...linked, replacementNote: note } : linked);
  return `Exchange ${made.id} opened · ${made.status}`;
}

/** One row per order line: add it to the build, or set how many are coming back. */
function LinePicker({
  items,
  chosen,
  onToggle,
  onQuantity,
}: {
  items: readonly StaffOrderLineDto[];
  chosen: Readonly<Record<string, number>>;
  onToggle: (id: string) => void;
  onQuantity: (id: string, quantity: number) => void;
}): ReactNode {
  if (items.length === 0) {
    return <p className="muted small">No lines on this order.</p>;
  }
  return (
    <ul className="action-lines">
      {items.map((line) => {
        const quantity = chosen[line.id] ?? 0;
        return (
          <li key={line.id}>
            <span className="action-name">
              {line.name} · {line.quantity} × {formatCents(line.unitPriceCents)}
            </span>
            <button type="button" className="chip" aria-pressed={quantity > 0} onClick={() => onToggle(line.id)}>
              {quantity > 0 ? 'Remove' : 'Add'}
            </button>
            {quantity > 0 ? (
              <label className="action-qty">
                Qty
                <input type="number" min={1} max={line.quantity} value={quantity} onChange={(event) => onQuantity(line.id, Number(event.target.value))} />
              </label>
            ) : null}
          </li>
        );
      })}
    </ul>
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
  if (decision === 'approved' || decision === 'partial_refund') {
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
  /** One count per decision value, including the ones only discretion produces. */
  readonly decisionsToday: Record<Decision, number>;
  readonly averageTakeoverMinutes: number | null;
  readonly since: string;
}

/** The order the pills read in: what was paid, what was refused, what waits. */
const DECISION_ORDER = [
  'approved',
  'partial_refund',
  'exchange',
  'store_credit',
  'denied',
  'escalated',
] as const satisfies readonly Decision[];

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
  // Summed over the enum rather than over a named list: the "decided today"
  // figure must include every outcome the system can produce, or a day resolved
  // by discretion reads as a day where nothing happened.
  const total = DECISION_ORDER.reduce((sum, decision) => sum + decisionsToday[decision], 0);
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
            {DECISION_ORDER.filter((decision) => decisionsToday[decision] > 0).map((decision) => (
              <span key={decision} className={`pill pill-${decision}`}>
                {decisionsToday[decision]} {decision.replace(/_/g, ' ')}
              </span>
            ))}
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
          Only a money decision authorises money. The old `!== 'denied'` test printed
          "$0.00" under every escalation, which is the exact figure a reader
          should never take away from an escalated case.
        */}
        {turn.decision === 'approved' || turn.decision === 'partial_refund' ? (
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
  orderId: string | null,
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
        await api.staffMessage(customerId, draft, dataUrl, orderId);
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
  orderId: string | null,
  body: string,
  onSent: () => void,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setError: React.Dispatch<React.SetStateAction<string>>,
  setDraft: React.Dispatch<React.SetStateAction<string>>,
): Promise<void> {
  setBusy(true);
  setError('');
  try {
    await api.staffMessage(customerId, body, undefined, orderId);
    setDraft('');
    onSent();
  } catch (cause: unknown) {
    setError(describe(cause));
  } finally {
    setBusy(false);
  }
}

/** The reply box, visible only while this agent has the thread. */
function Composer({ customerId, orderId, onSent }: { customerId: string; orderId: string | null; onSent: () => void }): ReactNode {
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
          void sendMessage(customerId, orderId, body, onSent, setBusy, setError, setDraft);
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
        onClick={() => handleAttachPhoto(customerId, orderId, draft, onSent, setDraft, setError)}
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