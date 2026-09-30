import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, Send, ShieldCheck } from 'lucide-react';
import { ErrorNote } from './components';
import { formatCents } from './format';
import { useConversation, type Conversation, type ReplyBody, type Turn } from './useConversation';
import { money, shopApi, type ShopOrder } from './shop/api';
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

  const chat = useConversation(customerId, selected.orderId, complaintFor(handoff?.issue ?? null));

  return (
    <div className="chat-layout">
      <aside className="chat-context">
        <h1>Get help</h1>
        <OrderScope
          orders={orderList}
          loading={orders.data === null && orders.error === null}
          selected={selected.orderId}
          onSelect={selected.select}
        />
        <AssistantStatus />
        <PolicyNote />
      </aside>

      <ChatThread chat={chat} />
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
function ChatThread({ chat }: { chat: Conversation }): ReactNode {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [chat.turns]);

  return (
    <section className="chat-main">
      <div className="chat-log" ref={logRef}>
        {/* Not the greeting: showing "what can I help with?" above a thread the
            customer can already see makes the page look like it forgot them.
            While loading, both it and the thread are absent, so the emptiness is
            brief and states itself. */}
        {chat.loading || chat.turns.length > 0 ? null : <Greeting onPick={chat.setDraft} />}
        {chat.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>

      <Composer
        draft={chat.draft}
        busy={chat.busy}
        blocked={chat.blocked}
        onDraft={chat.setDraft}
        onSend={chat.send}
      />
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
 * The order being asked about, and the only way to change it.
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
}: {
  orders: readonly ShopOrder[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
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

  const order = orders.find((candidate) => candidate.id === selected);
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
      {order !== undefined ? <OrderFacts order={order} /> : null}
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

const GREETING = "Tell me what went wrong and I'll check what the refund policy allows.";

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
        Nothing is broken while this is the case: every answer still comes from the written policy,
        and anything that needs a claim goes to a person for review.
      </p>
    </div>
  );
}

function Composer({
  draft,
  busy,
  blocked,
  onDraft,
  onSend,
}: {
  draft: string;
  busy: boolean;
  blocked: string | null;
  onDraft: (next: string) => void;
  onSend: () => Promise<void>;
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
        onChange={(event) => onDraft(event.target.value)}
      />
      <button type="submit" disabled={busy || blocked !== null} aria-label="Send">
        <Send size={16} />
        <span className="sr-only">Send</span>
      </button>
      {blocked !== null ? <p className="muted small">{blocked}</p> : null}
    </form>
  );
}

function TurnView({ turn }: { turn: Turn }): ReactNode {
  if (turn.kind === 'pending') {
    return <p className="bubble-pending">Checking the policy…</p>;
  }
  if (turn.kind === 'update') {
    return <FollowUpNotice text={turn.text} />;
  }
  if (turn.kind === 'stored') {
    // No duplicate notice: a suppressed repeat was never stored, so the history
    // is the original message and nothing needs explaining.
    return (
      <>
        <p className="bubble-me">{turn.text}</p>
        <Reply result={turn.result} duplicate={null} />
      </>
    );
  }
  if (turn.kind === 'storedAsk') {
    return (
      <>
        <p className="bubble-me">{turn.text}</p>
        <Question reply={turn.question} />
      </>
    );
  }
  if (turn.kind === 'asked') {
    return (
      <>
        <p className="bubble-me">{turn.text}</p>
        <Question reply={turn.question} />
      </>
    );
  }
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Reply result={turn.result} duplicate={turn.duplicate} />
    </>
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
function Reply({ result, duplicate }: { result: ReplyBody; duplicate: DuplicateNotice | null }): ReactNode {
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
