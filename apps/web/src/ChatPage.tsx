import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, Headset, Send, ShieldCheck } from 'lucide-react';
import { ErrorNote } from './components';
import { formatCents } from './format';
import { useConversation, type Conversation, type ReplyBody, type Turn } from './useConversation';
import { money, shopApi, type ShopOrder, describe } from './shop/api';
import type { DuplicateNotice } from './api';
import { reasonFor, REASONS } from './shop/issueReasons';
import { useAsyncData } from './shop/hooks';

/**
 * The customer's assistant.
 *
 * Three things this page must get right, each of which was a bug first.
 *
 * **It is scoped to the signed-in shopper.** An earlier version had a customer
 * picker listing every account in the database, because walking a demo through
 * several people's orders quickly was useful. It also made the storefront
 * indistinguishable from the staff console and let a shopper act as anyone. The
 * orders listed here come from the session's own endpoint; there is no
 * `customerId` control on this page at all.
 *
 * **An order is selected in the page, not handed in by the caller.** The
 * conversation refuses to send without one, because the policy needs an order to
 * reason about. It originally took the order from the query string alone, which
 * meant arriving from the nav - the most obvious way to reach "Get help" - left
 * the composer permanently disabled with no way to fix it. So the order is
 * chosen here, defaulting to the handoff when the Orders page supplied one and
 * to the most recent order otherwise.
 *
 * A return is a message like any other. It used to route to a separate Returns
 * form, on the reasoning that sending something back is a different kind of act
 * from asking for money back. In practice the customer had to say the same
 * thing twice - once here, once in a form - and the form could not answer a
 * question, only collect it. Everything now arrives as one conversation, and a
 * return that needs a person is escalated to one like anything else.
 */
export function ChatPage(): ReactNode {
  const handoff = useHandoff();
  const session = useAsyncData(() => shopApi.me(), ['me']);
  const customerId = session.data?.user?.customerId ?? null;
  const orders = useAsyncData(() => shopApi.orders(), ['help-orders']);
  const orderList = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  const selected = useSelectedOrder(orderList, handoff?.orderId ?? null);

  const order = useMemo(
    () => orderList.find((candidate) => candidate.id === selected.orderId) ?? null,
    [orderList, selected.orderId],
  );
  const [reportedItemIds, setReportedItemIds] = useState<readonly string[]>([]);
  const ticks = useItemTicks(order, reportedItemIds);

  const chat = useConversation(
    customerId,
    selected.orderId,
    complaintFor(handoff?.issue ?? null),
    ticks.itemIds,
  );

  useEffect(() => {
    const next = [...new Set(
      chat.turns.flatMap((turn) =>
        turn.kind === 'replied' || turn.kind === 'stored' ? turn.result.itemIds ?? [] : [],
      ),
    )];
    setReportedItemIds((current) => {
      if (current.length === next.length && current.every((id, index) => id === next[index])) {
        return current;
      }
      return next;
    });
  }, [chat.turns]);
  useShopSocket(customerId, chat.refresh);

  return (
    <div className="chat-layout">
      <aside className="chat-context">
        <h1>Get help with this order</h1>
        <OrderScope
          orders={orderList}
          loading={orders.data === null && orders.error === null}
          selected={selected.orderId}
          onSelect={selected.select}
          order={order}
          ticks={ticks}
          reportedItemIds={reportedItemIds}
        />
        <AssistantStatus />
        <PolicyNote />
      </aside>

      <ChatThread chat={chat} />
    </div>
  );
}

/**
 * Which order lines this message is about, and the only way to change that.
 *
 * The picker exists because the alternative is asking a customer to describe a
 * product in words, and words are matched by a heuristic: "the blue mug", "the
 * other one", "the thing I already sent back" all describe a line perfectly well
 * and none of them name it. Every line already carries an id, so a tick is an
 * unambiguous claim and the matcher is only consulted when nothing was ticked.
 *
 * Derived, not reset, on the same reasoning as the order selection above: an id
 * left behind on another order is simply not on this one, so a selection cannot
 * leak from one basket into another and nothing has to be written back to keep up
 * with a change of order.
 */
interface ItemTicks {
  readonly itemIds: readonly string[];
  readonly toggle: (itemId: string) => void;
}

function useItemTicks(order: ShopOrder | null, reportedItemIds: readonly string[] = []): ItemTicks {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const onThisOrder = new Set((order?.items ?? []).map((item) => item.itemId));
  const itemIds = chosen.filter((id) => onThisOrder.has(id) && !reportedItemIds.includes(id));

  const toggle = useCallback(
    (itemId: string) => {
      if (reportedItemIds.includes(itemId)) {
        return;
      }
      setChosen((previous) =>
        previous.includes(itemId) ? previous.filter((id) => id !== itemId) : [...previous, itemId],
      );
    },
    [reportedItemIds],
  );

  return { itemIds, toggle };
}

/**
 * Tick the items the claim is about.
 *
 * Hidden for a single-item order, where there is nothing to choose and a picker
 * with one box on it reads as a form field rather than as an answer. The caption
 * states both outcomes, because "the whole order" is a real claim the customer
 * makes by ticking nothing, and silence about it is how a basket-wide claim
 * happens by accident.
 */
function ItemPicker({ order, ticks, reportedItemIds }: { order: ShopOrder; ticks: ItemTicks; reportedItemIds: readonly string[] }): ReactNode {
  if (order.items.length < 2) {
    return null;
  }

  const alreadyReported = new Set(reportedItemIds);
  const disabledCount = order.items.filter((item) => alreadyReported.has(item.itemId)).length;

  return (
    <div className="item-picker">
      <span className="label">Which item is this about?</span>
      <ul className="lines">
        {order.items.map((item) => {
          const reported = alreadyReported.has(item.itemId);
          return (
            <li key={item.itemId}>
              <label className={reported ? 'muted' : undefined}>
                <input
                  type="checkbox"
                  checked={ticks.itemIds.includes(item.itemId)}
                  disabled={reported}
                  onChange={() => ticks.toggle(item.itemId)}
                  title={reported ? 'This item was already reported in this chat. Choose another item or tell me about a different problem.' : undefined}
                />
                <span>
                  {item.name}
                  {item.quantity > 1 ? ` x${item.quantity}` : ''}
                  {reported ? ' (already reported)' : ''}
                </span>
                <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        {disabledCount > 0
          ? 'This item was already reported in this chat. Please choose a different item from the order, or tell me about a different problem. I’m here to help with anything else.'
          : ticks.itemIds.length === 0
            ? 'Tick what went wrong and only that is treated as the claim. With nothing ticked, the whole order is.'
            : `${ticks.itemIds.length} ticked. Only those are treated as the claim.`}
      </p>
    </div>
  );
}

/**
 * The conversation itself: what has been said, and the box to say more in.
 *
 * Split out from the page because the thread owns a scroll position and the
 * decision of when to greet, and neither of those belongs to the layout that
 * frames them. The scroll is the subtle part - it moves to the bottom whenever
 * the turns change, so a message that arrives does not push the composer's
 * context out of view.
 */
interface ChatThreadDeps {
  readonly chat: Conversation;
  readonly inHandoff: boolean;
  readonly appealState: { readonly requestId: string; readonly reason: string; readonly submitting: boolean } | null;
  readonly setAppealState: React.Dispatch<React.SetStateAction<{ readonly requestId: string; readonly reason: string; readonly submitting: boolean } | null>>;
}

function handleAttachPhoto(deps: ChatThreadDeps): void {
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
      const requestTurn = deps.chat.turns.find((t) => t.kind === 'replied' || t.kind === 'stored');
      const orderId = requestTurn ? null : undefined;
      try {
        await shopApi.chatMedia({ orderId: orderId ?? null, caption: '', media: { dataUrl } });
        deps.chat.refresh();
      } catch (cause) {
        alert(describe(cause));
      }
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function handleAppeal(deps: ChatThreadDeps, requestId: string): Promise<void> {
  const reason = prompt('Why do you think this decision was wrong?');
  if (!reason || reason.trim().length < 10) {
    alert('Please provide a reason (at least 10 characters).');
    return;
  }
  deps.setAppealState({ requestId, reason: reason.trim(), submitting: true });
  try {
    await shopApi.fileAppeal(requestId, reason.trim());
    deps.setAppealState(null);
    deps.chat.refresh();
  } catch (cause) {
    alert(describe(cause));
    deps.setAppealState(null);
  }
}

function ChatThread({ chat }: { chat: Conversation }): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [chat.turns]);

  const inHandoff = chat.turns.some((turn) => turn.kind === 'handoff');

  const [appealState, setAppealState] = useState<{ requestId: string; reason: string; submitting: boolean } | null>(null);

  const deps: ChatThreadDeps = { chat, inHandoff, appealState, setAppealState };

  return (
    <section className="chat-main">
      <div className="chat-log" ref={logRef}>
        {/* Not the greeting: showing "what can I help with?" above a thread the
            customer can already see makes the page look like it forgot them.
            While loading, both it and the thread are absent, so the emptiness is
            brief and states itself. */}
        {chat.loading || chat.turns.length > 0 ? null : <Greeting onPick={chat.setDraft} />}
        {chat.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} {...(turn.kind === 'replied' && turn.result.decision === 'denied' ? { onAppeal: (id: string) => handleAppeal(deps, id) } : {})} />
        ))}
      </div>

      <Composer
        draft={chat.draft}
        busy={chat.busy}
        blocked={chat.blocked}
        closed={chat.closed}
        onDraft={chat.setDraft}
        onSend={chat.send}
        inHandoff={inHandoff}
        onAttachPhoto={() => handleAttachPhoto(deps)}
      />
      {appealState && <p className="muted small">Sending your appeal…</p>}
      {chat.error.length > 0 ? <ErrorNote error={chat.error} /> : null}
    </section>
  );
}

/**
 * Which order the assistant is answering about.
 *
 * The handoff wins when it names one the shopper actually has; a stale `?order=`
 * from a bookmark or a shared link falls back to their latest order instead of
 * leaving the page with nothing selected. Falling back rather than erroring is
 * the right call, because the shopper still gets a working assistant - just
 * about a different order - and the order is visible and changeable either way.
 *
 * Derived rather than synchronised. Only the customer's own explicit pick is
 * state; whether that pick is still usable is a question answered while
 * rendering. An effect that corrected the selection on every change of the order
 * list was doing this same calculation one render late - long enough to show the
 * previous order's conversation against the new order's name.
 */
function useSelectedOrder(
  orders: readonly ShopOrder[],
  handoffOrderId: string | null,
): { readonly orderId: string | null; readonly select: (id: string) => void } {
  const [chosen, setChosen] = useState<string | null>(null);
  const fallback = orders[0]?.id ?? null;
  const handoffValid = handoffOrderId !== null && orders.some((order) => order.id === handoffOrderId);

  if (chosen !== null && orders.some((order) => order.id === chosen)) {
    return { orderId: chosen, select: setChosen };
  }
  return { orderId: handoffValid ? handoffOrderId : fallback, select: setChosen };
}

/**
 * The live part of the conversation: somebody is *here* now.
 *
 * The shop socket only announces that something changed - "an agent is with
 * you", "an agent wrote back", "the takeover is over". The thread itself is
 * always re-read over REST, so what the customer sees is exactly what is stored,
 * which is exactly what the agent sees. The socket is small and one-directional;
 * the customer's own messages already go over the same REST call the pipeline
 * used, the server routes them to the agent, and this channel is just how they
 * learn the reply landed.
 */
function useShopSocket(customerId: string | null, onEvent: () => void): void {
  const handler = useRef(onEvent);

  // Written in an effect, not during render: a ref that is updated while the
  // component draws can be stale for a render the socket fires between, and it
  // is what the refs rule is about.
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (customerId === null) {
      return;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/shop/chat/ws`);
    socket.onmessage = () => handler.current();
    // `onclose` needs no special handling: the thread is re-read on every event,
    // so a dropped socket costs nothing but the notice arriving later.
    return () => socket.close();
  }, [customerId]);
}

/**
 * The order being asked about, its lines, and the only way to change either.
 *
 * The list is the shopper's own, loaded over their session. When it arrives empty
 * the page says so and links to the shop, because "the assistant is not working"
 * and "you have not bought anything yet" need different answers and a disabled
 * composer alone communicates neither.
 */
function OrderScope({
  orders,
  loading,
  selected,
  onSelect,
  order,
  ticks,
  reportedItemIds,
}: {
  orders: readonly ShopOrder[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  order: ShopOrder | null;
  ticks: ItemTicks;
  reportedItemIds: readonly string[];
}): ReactNode {
  if (loading) {
    return <p className="muted small">Loading your orders…</p>;
  }
  if (orders.length === 0) {
    return (
      <div className="note">
        <p className="small">
          You have not bought anything yet, so there is nothing to check a refund against.{' '}
          <Link to="/">Have a look at the shop</Link> - every product there exists to make a
          different policy decision.
        </p>
      </div>
    );
  }

  return (
    <div className="order-scope">
      <label className="stack-sm">
        <span className="label">About this order</span>
        <select
          value={selected ?? ''}
          onChange={(change) => onSelect(change.target.value)}
        >
          {orders.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id} · {money(candidate.totalCents)}
            </option>
          ))}
        </select>
      </label>
      {order !== null ? <OrderFacts order={order} /> : null}
      {order !== null ? <ItemPicker order={order} ticks={ticks} reportedItemIds={reportedItemIds} /> : null}
    </div>
  );
}

function OrderFacts({ order }: { order: ShopOrder }): ReactNode {
  return (
    <div className="order-facts">
      <dl className="kv">
        <dt>Placed</dt>
        <dd>{new Date(order.placedAt).toLocaleDateString()}</dd>
        <dt>Status</dt>
        <dd>{order.status.replace(/_/g, ' ')}</dd>
        <dt>Payment</dt>
        <dd>{order.paymentState.replace(/_/g, ' ')}</dd>
      </dl>
      <ul className="lines">
        {order.items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <span>
              {item.name}
              {item.quantity > 1 ? ` x${item.quantity}` : ''}
            </span>
            <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The order the Orders page handed over, if any.
 *
 * Only the id travels. The reason travels as an id too, and the wording is
 * rebuilt here from the shared list rather than trusted from the URL - a link is
 * not a place to put a sentence a customer will then read as something they
 * said.
 */
function useHandoff(): { readonly orderId: string; readonly issue: string | null } | null {
  const [params] = useSearchParams();
  const orderId = params.get('order');
  if (orderId === null) {
    return null;
  }
  return { orderId, issue: params.get('issue') };
}

/**
 * The wording for a reason the Orders page handed over.
 *
 * Rebuilt from the shared list rather than taken from the URL, and empty for a
 * reason with no wording of its own - "Something else" is a starting point, not
 * a sentence, so that one opens an empty composer.
 */
function complaintFor(issue: string | null): string {
  return reasonFor(issue)?.complaint ?? '';
}

const GREETING = "Tell me what went wrong with this order and I'll check what the refund policy allows.";

function Greeting({ onPick }: { onPick: (text: string) => void }): ReactNode {
  return (
    <div className="bubble-them">
      <p>{GREETING}</p>
      <ul className="quick-actions">
        {REASONS.filter((reason) => reason.id !== 'other').map((reason) => (
          <li key={reason.id}>
            <button type="button" className="chip" onClick={() => onPick(reason.complaint)}>
              {reason.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Whether a model is actually behind this.
 *
 * The policy decides either way, so this is not load-bearing - but a page that
 * silently behaves identically with and without a model is indistinguishable
 * from a model that is not being called. Saying which is in play, and saying
 * when it is not, is the difference between "the assistant is down" and "there
 * is no key configured, so a person reviews this one".
 */
function AssistantStatus(): ReactNode {
  const status = useAsyncData(() => shopApi.assistantStatus(), ['assistant-status']);
  if (status.data === null) {
    return null;
  }
  const { aiMode, aiAvailable, aiNote } = status.data;
  if (aiAvailable) {
    return (
      <div className="note note-sm">
        <p className="small">
          <strong>{`Model: ${aiMode}`}</strong>
          <br />
          It reads the complaint. The written policy still makes the decision.
        </p>
      </div>
    );
  }
  return (
    <div className="note note-warn">
      <p className="small">
        <strong>No model configured</strong>
      </p>
      <p className="small">{aiNote}</p>
      <p className="small">
        The written policy still handles the case, and any request that needs a refund decision is
        sent to a person for review instead of being guessed by a model.
      </p>
    </div>
  );
}

function Composer({
  draft,
  busy,
  blocked,
  closed,
  onDraft,
  onSend,
  inHandoff,
  onAttachPhoto,
}: {
  draft: string;
  busy: boolean;
  blocked: string | null;
  closed: boolean;
  onDraft: (next: string) => void;
  onSend: () => Promise<void>;
  inHandoff: boolean;
  onAttachPhoto: () => void;
}): ReactNode {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
    >
      <input
        value={draft}
        maxLength={4000}
        aria-label="Describe the problem"
        placeholder="Describe what went wrong…"
        disabled={closed}
        onChange={(event) => onDraft(event.target.value)}
      />
      {inHandoff && (
        <button
          type="button"
          disabled={busy || closed}
          aria-label="Attach a photo"
          onClick={onAttachPhoto}
          className="composer-photo"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>
      )}
      <button type="submit" disabled={busy || blocked !== null} aria-label="Send">
        <Send size={16} />
        <span className="sr-only">Send</span>
      </button>
      {blocked !== null ? <p className="muted small">{blocked}</p> : null}
    </form>
  );
}

function TurnView({ turn, onAppeal }: { turn: Turn; onAppeal?: (requestId: string) => void | Promise<void> }): ReactNode {
  if (turn.kind === 'pending') {
    return <PendingBubble text={turn.text} />;
  }
  if (turn.kind === 'handoff') {
    return <AgentNotice text={turn.text} />;
  }
  if (turn.kind === 'agent') {
    return <AgentBubble turn={turn} />;
  }
  if (turn.kind === 'update') {
    return <FollowUpNotice text={turn.text} />;
  }
  if (turn.kind === 'stored') {
    return <StoredDecisionBubble turn={turn} {...(onAppeal !== undefined ? { onAppeal } : {})} />;
  }
  if (turn.kind === 'storedAsk' || turn.kind === 'asked') {
    return <QuestionBubble turn={turn} />;
  }
  return <LiveDecisionBubble turn={turn} {...(onAppeal !== undefined ? { onAppeal } : {})} />;
}

function PendingBubble({ text }: { text: string }): ReactNode {
  return (
    <>
      <p className="bubble-me">{text}</p>
      <TypingBubble />
    </>
  );
}

function AgentBubble({ turn }: { turn: Turn & { kind: 'agent' } }): ReactNode {
  if (turn.sender === 'customer') {
    return (
      <>
        <p className="bubble-me">{turn.text}</p>
        {turn.media && <img src={turn.media.url} alt="Photo from customer" className="chat-media" />}
      </>
    );
  }
  return <AgentReply text={turn.text} media={turn.media ?? null} />;
}

function QuestionBubble({ turn }: { turn: Turn & { kind: 'storedAsk' | 'asked' } }): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Question reply={turn.question} />
    </>
  );
}

function StoredDecisionBubble({
  turn,
  onAppeal,
}: { turn: Turn & { kind: 'stored' }; onAppeal?: (requestId: string) => void | Promise<void> }): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Reply result={turn.result} duplicate={null} requestId={turn.id} {...(onAppeal !== undefined ? { onAppeal } : {})} />
    </>
  );
}

function LiveDecisionBubble({
  turn,
  onAppeal,
}: { turn: Turn & { kind: 'replied' }; onAppeal?: (requestId: string) => void | Promise<void> }): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Reply result={turn.result} duplicate={turn.duplicate} requestId={turn.id} {...(onAppeal !== undefined ? { onAppeal } : {})} />
    </>
  );
}

/**
 * The assistant at work: the customer's own bubble, then a thinking bubble in
 * the assistant's place style. Replaces the old plain "Checking the policy…"
 * label, which read as a system message rather than as the assistant replying.
 */
function TypingBubble(): ReactNode {
  return (
    <div className="bubble-them bubble-typing" role="status" aria-live="polite">
      <Bot size={16} />
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
      <span className="sr-only">Checking the refund policy</span>
    </div>
  );
}

/**
 * The moment a person took over the thread.
 *
 * The notice is derived from the takeover row, not stored as a message, and it
 * is the one thing in the thread that says *who* is answering now. Without it, a
 * person's first reply would read exactly like an assistant reply - and the
 * customer would be right to wonder which script said that.
 */
function AgentNotice({ text }: { text: string }): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">
        <Headset size={16} />
        <span className="pill pill-escalated">A customer agent is with you</span>
      </div>
      <p>{text}</p>
    </div>
  );
}

/**
 * A customer agent's reply, marked as a person's.
 *
 * Deliberately not a `Reply`: there is no decision, no amount, and no status
 * pill, because this is a conversation, not an outcome - the customer is talking
 * to a person who is deciding with them, not after them.
 */
function AgentReply({ text, media }: { text: string; media: { type: string; url: string; bytes: number } | null }): ReactNode {
  return (
    <div className="bubble-them bubble-agent">
      <p>{text}</p>
      {media && <img src={media.url} alt="Photo from agent" className="chat-media" />}
      <footer className="row small muted">
        <Headset size={14} />
        Customer agent
      </footer>
    </div>
  );
}

/**
 * The assistant asking for the one missing detail.
 *
 * Deliberately not a `Reply`: a question is not a decision, has no amount, and
 * has no status pill to show. It is drawn as a question so a customer can tell
 * "we are still talking" from "you have an answer" at a glance - and answering
 * it is exactly what the composer stays open for.
 */
function Question({ reply }: { reply: string }): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">
        <Bot size={16} />
        <span className="pill pill-escalated">One quick question</span>
      </div>
      <p>{reply}</p>
      <footer className="row small muted">Answer this and I can check what the refund policy allows.</footer>
    </div>
  );
}

/**
 * The answer to a message.
 *
 * A suppressed repeat is marked rather than shown as a fresh decision. Without
 * the marker, sending the same complaint twice produces two identical-looking
 * replies and the customer concludes the second one was ignored - which is
 * closer to the truth than it should be, and sends them off to try a third time.
 */
function Reply({ result, duplicate, onAppeal, requestId }: { result: ReplyBody; duplicate: DuplicateNotice | null; onAppeal?: (requestId: string) => void | Promise<void>; requestId?: string }): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">
        <Bot size={16} />
        <span className={`pill pill-${result.decision}`}>{result.decision}</span>
      </div>
      {duplicate === null ? null : (
        <p className="small muted">
          Shown from your request on {new Date(duplicate.firstReportedAt).toLocaleString()}. This is the
          same message, so it was not decided a second time.
        </p>
      )}
      <p>{result.responseText}</p>
      <footer className="row small">
        {result.decision !== 'denied' ? <strong>{formatCents(result.refundAmountCents)}</strong> : null}
        {result.decision === 'escalated' ? (
          <span className="muted">Someone confirms this by hand before anything is paid.</span>
        ) : null}
        {result.decision === 'denied' && onAppeal !== undefined && requestId !== undefined && (
          <button
            type="button"
            className="button-secondary small"
            onClick={() => {
              void onAppeal(requestId);
            }}
            aria-label="Appeal this decision"
          >
            Appeal this decision
          </button>
        )}
      </footer>
    </div>
  );
}

/**
 * What a person decided, arriving in the thread afterwards.
 *
 * Styled as a note rather than a reply, and labelled, because this is the one
 * thing in the thread the assistant did not decide: a member of staff did. A
 * customer reading "approved" in the same bubble as everything else would have
 * no way to know a person was involved - and that difference is the whole
 * reason they were still waiting.
 */
function FollowUpNotice({ text }: { text: string }): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">
        <ShieldCheck size={16} />
        <span className="pill pill-escalated">Reviewed by a person</span>
      </div>
      <p>{text}</p>
    </div>
  );
}

/** Why the answer is never "the model felt like it". */
function PolicyNote(): ReactNode {
  return (
    <div className="note">
      <ShieldCheck size={16} />
      <p className="small">
        Every answer comes from a written refund rule, not from a model&apos;s opinion. A human
        checks anything money is involved in.
      </p>
    </div>
  );
}
