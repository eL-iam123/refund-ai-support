import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Headset, Inbox, Send, User, Scale, ShieldAlert } from 'lucide-react';
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

  // The staff socket announces arrivals and replies; the list and the open case
  // are both re-read, because the socket carries no bodies on purpose. See the
  // comment on LiveHub for why notify-then-refetch beats pushing copies.
  useEffect(() => {
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/staff/conversation/ws`,
    );
    socket.onmessage = () => setVersion((v) => v + 1);
    return () => socket.close();
  }, []);

  return (
    <div className="admin-page">
      <div className="console-intro">
        <div>
          <h1>Live</h1>
          <p className="lede">
            Conversations that moved in the last 24 hours. Pick one to read the case and, if a
            colleague has taken it over, to answer the customer yourself.
          </p>
        </div>
      </div>
      <div className="live-layout">
        <AnalyticsStrip analytics={analytics} />
        <ConversationList conversations={conversations} selected={selected} onSelect={setSelected} />
        <section className="live-console">
          {selected === null ? (
            <p className="empty">No conversation open. Choose one from the list.</p>
          ) : (
            <TakeoverConsole
              key={conversationKey(selected)}
              conversation={selected}
              version={version}
              onChanged={() => setVersion((v) => v + 1)}
            />
          )}
        </section>
      </div>
    </div>
  );
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
}: {
  conversations: { readonly data: readonly StaffConversation[] | null; readonly error: string | null };
  selected: StaffConversation | null;
  onSelect: (row: StaffConversation) => void;
}): ReactNode {
  return (
    <aside className="live-list panel">
      <div className="panel-head">
        <h2>Conversations</h2>
        <span className="muted small">{conversations.data === null ? '' : `${conversations.data.length} open`}</span>
      </div>
      {conversations.error !== null ? <p className="error">{conversations.error}</p> : null}
      {renderRows(conversations.data, selected, onSelect)}
    </aside>
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
            <span className="live-row-name">
              {row.customerName}
              {row.activeHandoff !== null ? (
                <span className="pill pill-escalated" title="A colleague has taken this over">taken over</span>
              ) : null}
              {row.openAppeals.length > 0 ? (
                <span className="pill pill-denied" title={row.openAppeals.map((a) => a.reason).join('; ')}>
                  {row.openAppeals.length} appeal{row.openAppeals.length > 1 ? 's' : ''}
                </span>
              ) : null}
            </span>
            <span className="small muted">
              {row.orderId ?? 'No order yet'} · {row.activityCount} message{row.activityCount === 1 ? '' : 's'} ·{' '}
              {formatTime(row.lastActivityAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One conversation: the case file, the thread, and the takeover verbs.
 *
 * The briefing and the thread come from the staff endpoint in one read, so two
 * agents opening the same conversation see the same case - the briefing is
 * derived, not cached, and the freshness is the point.
 */
function TakeoverConsole({
  conversation,
  version,
  onChanged,
}: {
  conversation: StaffConversation;
  version: number;
  onChanged: () => void;
}): ReactNode {
  const caseFile = useAsyncData(
    () => api.staffConversation(conversation.customerId, conversation.orderId).then((result) => result),
    ['live-case', conversation.customerId, conversation.orderId, version],
  );
  const [errand, setErrand] = useState<string>('');

  if (caseFile.data === null) {
    return caseFile.error !== null ? <p className="error">{caseFile.error}</p> : <Spinner />;
  }

  const { thread, brief } = caseFile.data;
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
      <header className="case-head">
        <div>
          <h2>{brief.customerName}</h2>
          <p className="muted small">
            {brief.orderId ?? 'No order yet'} · {STATE_TEXT[brief.state]}
          </p>
        </div>
        {active === null ? (
          <button type="button" className="btn" onClick={() => void run(() => api.staffTakeOver(conversation.customerId, conversation.orderId))}>
            <Headset size={16} /> Take over
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => void run(() => api.staffHandBack(conversation.customerId))}>
            Hand back to the assistant
          </button>
        )}
      </header>
      {errand.length > 0 ? <p className="error">{errand}</p> : null}

      {/*
        The case file sits beside the thread rather than above it, because the
        order an agent works in is: read the conversation, then check what the
        pipeline concluded before replying. Stacked, the case file pushes the
        thread below the fold on a long case, and the reply box with it.
      */}
      <div className="case-split">
        <div className="case-file">
          <CaseBrief brief={brief} />
        </div>
        <div className="case-thread">
          <ThreadView thread={thread} />
          {active !== null ? <Composer customerId={conversation.customerId} onSent={onChanged} /> : null}
        </div>
      </div>
    </div>
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
    <div className="case-brief">
      <RiskFlags brief={brief} />
      <details>
        <summary>
          Case file <span className="muted small">what was asked, what was checked, what was decided</span>
        </summary>
        <div className="case-columns">
          <WordsColumn brief={brief} />
          <EvidenceColumn brief={brief} />
        </div>
      </details>
    </div>
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
        {claim.decision === 'approved' ? (
          formatCents(claim.refundAmountCents)
        ) : claim.decision === 'escalated' ? (
          <span className="muted">{formatCents(claim.refundAmountCents)} proposed - not payable</span>
        ) : (
          <span className="muted">Nothing payable</span>
        )}
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

function PolicyTrail({ brief }: { brief: HandoffBrief }): ReactNode {
  if (brief.policyTrail.length === 0) {
    return null;
  }
  const blocking = brief.policyTrail.filter((rule) => rule.outcome !== 'pass').length;
  return (
    <>
      <h3>
        <Scale size={13} aria-hidden="true" /> Rules that ran ({blocking} of {brief.policyTrail.length}{' '}
        decided)
      </h3>
      <ul className="case-quotes">
        {brief.policyTrail.map((rule) => (
          <li key={rule.ruleId}>
            <span className={`pill ${OUTCOME_PILL[rule.outcome]}`}>{rule.ruleId}</span>{' '}
            <span className="small">{rule.evidence}</span>
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
        <p key={flag.label} className="note note-warn">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>
            <strong>{flag.label}.</strong> {flag.detail}
          </span>
        </p>
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

/** The live queue snapshot at the top of the page. */
function AnalyticsStrip({
  analytics,
}: {
  analytics: {
    readonly data: {
      readonly openHandoffs: number;
      readonly escalatedAwaiting: number;
      readonly awaitingReviewCents: number;
      readonly decisionsToday: { readonly approved: number; readonly denied: number; readonly escalated: number };
      readonly averageTakeoverMinutes: number | null;
      readonly since: string;
    } | null;
    readonly error: string | null;
  };
}): ReactNode {
  if (analytics.data === null) {
    return analytics.error !== null ? <p className="error">{analytics.error}</p> : <Spinner />;
  }
  const {
    openHandoffs,
    escalatedAwaiting,
    awaitingReviewCents,
    decisionsToday,
    averageTakeoverMinutes,
    since,
  } = analytics.data;
  const waitingOnYou = openHandoffs + escalatedAwaiting;
  return (
    <aside className="live-analytics">
      <ul className="analytics-grid">
        <li className="analytics-item">
          <span className="analytics-label">Waiting on an agent</span>
          <span className="analytics-value">
            <strong>{waitingOnYou}</strong>
          </span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Needs review money</span>
          <span className="analytics-value">
            <strong>{money(awaitingReviewCents)}</strong>
          </span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Decisions today</span>
          <span className="analytics-value small">
            <span className="pill pill-approved">{decisionsToday.approved} approved</span>
            <span className="pill pill-denied">{decisionsToday.denied} denied</span>
            <span className="pill pill-escalated">{decisionsToday.escalated} escalated</span>
          </span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Average takeover</span>
          <span className="analytics-value">
            {averageTakeoverMinutes === null ? 'No data' : `${Math.round(averageTakeoverMinutes)} min`}
          </span>
        </li>
      </ul>
      <p className="muted small">Counted from {formatTime(since)}</p>
    </aside>
  );
}


function RequestTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'request' }> }): ReactNode {
  return (
    <>
      <div className="bubble-me">
        <span className="who">
          <User size={13} aria-hidden="true" /> Customer
        </span>
        <p>{turn.message}</p>
        <span className="when">{formatTime(turn.createdAt)}</span>
      </div>
      <div className="bubble-them">
        <div className="row">
          <Bot size={16} aria-hidden="true" />
          <span className={`pill pill-${turn.decision}`}>{turn.decision}</span>
          <span className="when">{formatTime(turn.createdAt)}</span>
        </div>
        <p>{turn.responseText}</p>
        {/*
          Only an approval authorises money. The old `!== 'denied'` test printed
          "$0.00" under every escalation, which is the exact figure a reader
          should never take away from an escalated case.
        */}
        {turn.decision === 'approved' ? (
          <footer className="row small">{formatCents(turn.refundAmountCents)} authorised</footer>
        ) : null}
      </div>
    </>
  );
}

function DialogueTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'dialogue' }> }): ReactNode {
  return (
    <>
      <div className="bubble-me">
        <span className="who">
          <User size={13} aria-hidden="true" /> Customer
        </span>
        <p>{turn.message}</p>
      </div>
      <div className="bubble-them">
        <div className="row">
          <Bot size={16} aria-hidden="true" />
          <span className="pill">Assistant asked</span>
          <span className="when">{formatTime(turn.createdAt)}</span>
        </div>
        <p>{turn.question}</p>
      </div>
    </>
  );
}

function UpdateTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'update' }> }): ReactNode {
  return (
    <div className="bubble-them">
      <span className="pill pill-escalated">Reviewed by a person</span>
      <p>{turn.body}</p>
      <span className="when">{formatTime(turn.createdAt)}</span>
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'agent' }> }): ReactNode {
  if (turn.sender === 'customer') {
    return (
      <div className="bubble-me">
        <span className="who">
          <User size={13} aria-hidden="true" /> Customer
        </span>
        <p>{turn.body}</p>
        {turn.media !== null ? <img src={turn.media.url} alt="Photo sent by the customer" className="chat-media" /> : null}
        <span className="when">{formatTime(turn.createdAt)}</span>
      </div>
    );
  }
  return (
    <div className="bubble-them bubble-agent">
      <span className="who">
        <Headset size={13} aria-hidden="true" /> Customer agent
      </span>
      <p>{turn.body}</p>
      {turn.media !== null ? <img src={turn.media.url} alt="Photo sent by the agent" className="chat-media" /> : null}
      <span className="when">{formatTime(turn.createdAt)}</span>
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