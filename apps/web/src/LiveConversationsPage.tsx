import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Headset, Inbox, Send, Activity } from 'lucide-react';
import {
  api,
  describe,
  type HandoffBrief,
  type StaffConversation,
  type StaffThreadTurn,
} from './api';
import { formatCents } from './format';
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
    <div className="live-layout">
      <AnalyticsStrip analytics={analytics} />
      <ConversationList conversations={conversations} selected={selected} onSelect={setSelected} />
      <section className="live-console">
        {selected === null ? (
          <p className="empty">Pick a conversation to take over.</p>
        ) : (
          <TakeoverConsole
            key={selected.customerId}
            conversation={selected}
            version={version}
            onChanged={() => setVersion((v) => v + 1)}
          />
        )}
      </section>
    </div>
  );
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
  return (
    <aside className="live-list">
      <h1>Live</h1>
      <p className="muted small">Conversations moving in the last 24 hours.</p>
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
      <p className="note">
        <Inbox size={16} /> Nothing is moving. When a customer writes to the assistant, the
        conversation appears here.
      </p>
    );
  }
  return (
    <ul className="live-list-rows">
      {rows.map((row) => (
        <li key={row.customerId}>
          <button
            type="button"
            className={`live-row ${selected?.customerId === row.customerId ? 'is-active' : ''}`}
            onClick={() => onSelect(row)}
          >
            <span className="live-row-name">
              {row.customerName}
              {row.activeHandoff !== null ? <span className="pill pill-escalated">live</span> : null}
              {row.openAppeals.length > 0 && (
                <span className="pill pill-denied" title={row.openAppeals.map((a) => a.reason).join('; ')}>
                  {row.openAppeals.length} appeal{row.openAppeals.length > 1 ? 's' : ''}
                </span>
              )}
            </span>
            <span className="small muted">
              {row.orderId ?? 'no order yet'} · {new Date(row.lastActivityAt).toLocaleTimeString()}
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
    <div className="stack">
      <div className="row">
        <div>
          <h2>{brief.customerName}</h2>
          <p className="muted small">
            {brief.orderId ?? 'No order yet'} · state: <strong>{brief.state}</strong>
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
      </div>
      {errand.length > 0 ? <p className="error">{errand}</p> : null}

      <CaseBrief brief={brief} />
      <ThreadView thread={thread} />
      {active !== null ? <Composer customerId={conversation.customerId} onSent={onChanged} /> : null}
    </div>
  );
}

/** The deterministic briefing every agent reads before answering. */
function CaseBrief({ brief }: { brief: HandoffBrief }): ReactNode {
  return (
    <details className="case-brief" open>
      <summary>
        Case file <span className="muted small">- what the customer said, what the assistant secured, what the policy concluded</span>
      </summary>
      <div className="case-columns">
        <WordsColumn brief={brief} />
        <EvidenceColumn brief={brief} />
      </div>
      <RiskFlags brief={brief} />
    </details>
  );
}

function WordsColumn({ brief }: { brief: HandoffBrief }): ReactNode {
  return (
    <section>
      <h3>The customer&apos;s words</h3>
      {brief.whatTheySaid.length === 0 ? (
        <p className="muted small">Nothing on record yet.</p>
      ) : (
        <ul className="case-quotes">
          {brief.whatTheySaid.map((line, index) => (
            <li key={index}>“{line.text}”</li>
          ))}
        </ul>
      )}
      {brief.dialogue.length > 0 ? (
        <>
          <h3>What the assistant asked</h3>
          <ul className="case-dialogue">
            {brief.dialogue.map((turn, index) => (
              <li key={index}>
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
      <h3>Evidence the assistant secured</h3>
      {brief.echoedEvidence.length === 0 ? (
        <p className="muted small">None verified against the customer&apos;s own words.</p>
      ) : (
        <ul className="case-quotes">
          {brief.echoedEvidence.map((quote, index) => (
            <li key={index}>“{quote}”</li>
          ))}
        </ul>
      )}

      <h3>The claim</h3>
      <ClaimLines claim={brief.claim} />
      <PolicyTrail brief={brief} />
    </section>
  );
}

function ClaimLines({
  claim,
}: {
  claim: HandoffBrief['claim'];
}): ReactNode {
  if (claim === null) {
    return <p className="muted small">No claim produced on this thread yet - it may still be mid-clarify.</p>;
  }
  return (
    <dl className="kv">
      <dt>Decision</dt>
      <dd>
        <span className={`pill pill-${claim.decision}`}>{claim.decision}</span>
      </dd>
      <dt>Authorised amount</dt>
      <dd>{formatCents(claim.refundAmountCents)}</dd>
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
  return (
    <>
      <h3>How the policy decided</h3>
      <ul className="case-quotes">
        {brief.policyTrail.map((rule, index) => (
          <li key={index}>
            <span className={`pill pill-${rule.outcome}`}>{rule.ruleId}</span>{' '}
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
      {brief.riskFlags.map((flag, index) => (
        <p key={index} className="note note-warn">
          <strong>{flag.label}.</strong> {flag.detail}
        </p>
      ))}
    </div>
  );
}

/** The thread, drawn the way the customer sees it. */
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
function AnalyticsStrip({ analytics }: { analytics: { readonly data: { readonly openHandoffs: number; readonly escalatedAwaiting: number; readonly awaitingReviewCents: number; readonly decisionsToday: { readonly approved: number; readonly denied: number; readonly escalated: number }; readonly averageTakeoverMinutes: number | null; readonly since: string } | null; readonly error: string | null } }): ReactNode {
  if (analytics.data === null) {
    return analytics.error !== null ? <p className="error">{analytics.error}</p> : <Spinner />;
  }
  const { openHandoffs, escalatedAwaiting, awaitingReviewCents, decisionsToday, averageTakeoverMinutes, since } = analytics.data;
  return (
    <aside className="live-analytics">
      <h2><Activity size={16} /> Live queue</h2>
      <ul className="analytics-grid">
        <li className="analytics-item">
          <span className="analytics-label">Agents with customers</span>
          <span className="analytics-value"><strong>{openHandoffs}</strong></span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Escalated awaiting hand-off</span>
          <span className="analytics-value"><strong>{escalatedAwaiting}</strong></span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Money awaiting review</span>
          <span className="analytics-value"><strong>{money(awaitingReviewCents)}</strong></span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Decided today</span>
          <span className="analytics-value small">
            <span className="pill pill-approved">{decisionsToday.approved}</span>
            <span className="pill pill-denied">{decisionsToday.denied}</span>
            <span className="pill pill-escalated">{decisionsToday.escalated}</span>
          </span>
        </li>
        <li className="analytics-item">
          <span className="analytics-label">Avg takeover time</span>
          <span className="analytics-value">
            {averageTakeoverMinutes !== null ? `${Math.round(averageTakeoverMinutes)} min` : '—'}
          </span>
        </li>
      </ul>
      <p className="muted small">Since {new Date(since).toLocaleString()}</p>
    </aside>
  );
}


function RequestTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'request' }> }): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.message}</p>
      <div className="bubble-them">
        <div className="row">
          <Bot size={16} />
          <span className={`pill pill-${turn.decision}`}>{turn.decision}</span>
        </div>
        <p>{turn.responseText}</p>
        {turn.decision !== 'denied' ? (
          <footer className="row small">{formatCents(turn.refundAmountCents)}</footer>
        ) : null}
      </div>
    </>
  );
}

function DialogueTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'dialogue' }> }): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.message}</p>
      <div className="bubble-them">
        <div className="row">
          <Bot size={16} />
          <span className="pill pill-escalated">Assistant asked</span>
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
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'agent' }> }): ReactNode {
  if (turn.sender === 'customer') {
    return (
      <>
        <p className="bubble-me">{turn.body}</p>
        {turn.media && <img src={turn.media.url} alt="Photo from customer" className="chat-media" />}
      </>
    );
  }
  return (
    <div className="bubble-them bubble-agent">
      <p>{turn.body}</p>
      {turn.media && <img src={turn.media.url} alt="Photo from agent" className="chat-media" />}
      <footer className="row small muted">
        <Headset size={14} /> Customer agent
      </footer>
    </div>
  );
}

function HandoffTurn({ turn }: { turn: Extract<StaffThreadTurn, { kind: 'handoff' }> }): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">
        <Headset size={16} />
        <span className="pill pill-escalated">Takeover live</span>
      </div>
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