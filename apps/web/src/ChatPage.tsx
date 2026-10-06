import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, Headset, Send, ShieldCheck } from 'lucide-react';
import { ErrorNote } from './components';
import { formatCents } from './format';
import { useConversation, type Conversation, type ReplyBody, type Turn } from './useConversation';
import { money, shopApi, type Product, type ShopOrder, describe } from './shop/api';
import { addToCart } from './shop/cartStore';
import type { DuplicateNotice, ItemChoice, ItemPickerOffer } from './api';
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
  // Support is the refund conversation about one order; shopping is order
  // status, return logistics and browsing with no order selected. The server
  // re-classifies every message either way, so the toggle is a lens for the
  // customer rather than a promise about which pipeline answers.
  const [mode, setMode] = useState<'support' | 'shopping'>('support');
  const shopping = mode === 'shopping';

  const order = useMemo(
    () => (shopping ? null : (orderList.find((candidate) => candidate.id === selected.orderId) ?? null)),
    [orderList, selected.orderId, shopping],
  );
  const chat = useConversation(
    customerId,
    shopping ? null : selected.orderId,
    complaintFor(handoff?.issue ?? null),
    shopping,
  );
  // Settled and awaiting are different things, and treating them as one cost the
  // customer the ability to talk about the item they had just complained about: an
  // escalation marks its lines as reported, so after the first "it needs a person"
  // every option greyed out except lines nobody had claimed - which reads as "you
  // may only complain about the subscription".
  const claimScope = useMemo(() => claimState(chat.turns), [chat.turns]);
  const ticks = useItemTicks(order, claimScope.settled);
  const [retrying, setRetrying] = useState(false);
  const showRetrying = useCallback(() => setRetrying(true), []);
  useShopSocket(customerId, chat.refresh, showRetrying);

  return (
    <div className="chat-layout">
      <aside className="chat-context">
        <h1>{shopping ? 'Shopping help' : 'Get help with this order'}</h1>
        <div className="row" role="group" aria-label="Assistant mode">
          <button
            type="button"
            className={shopping ? 'chip' : 'chip chip-active'}
            aria-pressed={!shopping}
            onClick={() => setMode('support')}
          >
            Refund help
          </button>
          <button
            type="button"
            className={shopping ? 'chip chip-active' : 'chip'}
            aria-pressed={shopping}
            onClick={() => setMode('shopping')}
          >
            Shopping help
          </button>
        </div>
        {shopping ? (
          <ShoppingPanel />
        ) : (
          <OrderScope
            orders={orderList}
            loading={orders.data === null && orders.error === null}
            selected={selected.orderId}
            onSelect={selected.select}
            order={order}
          />
        )}
        <AssistantStatus />
        <PolicyNote />
      </aside>

      <ChatThread
        chat={chat}
        order={order}
        ticks={ticks}
        claimScope={claimScope}
        retrying={retrying && chat.busy}
      />
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
  readonly clear: () => void;
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

  return { itemIds, toggle, clear: useCallback(() => setChosen([]), []) };
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
/** The lines the last assistant question asked about, or none if it did not ask. */
function clarificationFrom(turn: Turn | undefined): readonly string[] {
  return turn?.kind === 'asked' || turn?.kind === 'storedAsk' ? turn.itemIds : [];
}

/**
 * Send from the composer.
 *
 * It never withholds the message. It used to: a multi-line order with nothing
 * ticked opened the picker instead of sending, which made the customer's words
 * contingent on choosing a line first, and the picker read as a form field rather
 * than as an answer. The item scope is still the customer's to give - either here,
 * by scoping the message to a line, or by tapping the assistant's offer when it
 * asks - but the message goes either way, and a whole-order claim is a claim they
 * can simply make.
 */
function composerSend(
  chat: Conversation,
  selectedItemIds: readonly string[],
  clarificationItemIds: readonly string[],
): Promise<void> {
  return chat.send(selectedItemIds.length > 0 ? selectedItemIds : clarificationItemIds);
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

function ChatThread({
  chat,
  order,
  ticks,
  claimScope,
  retrying,
}: {
  chat: Conversation;
  order: ShopOrder | null;
  ticks: ItemTicks;
  /** Which lines are done with, and which are still with a person. */
  claimScope: ClaimScope;
  /**
   * The server is retrying after a model failure, and said so.
   *
   * Already gated on the request being in flight by the caller: a flag that had to be
   * cleared when the reply arrived would need an effect to clear it, and a flag that
   * outlives its request is worse than one that is simply not shown.
   */
  retrying: boolean;
}): ReactNode {
  const logRef = useScrollToBottom(chat.turns);
  const inHandoff = chat.turns.some((turn) => turn.kind === 'handoff');

  const [appealState, setAppealState] = useState<{ requestId: string; reason: string; submitting: boolean } | null>(null);

  const deps: ChatThreadDeps = { chat, inHandoff, appealState, setAppealState };
  const clarificationItemIds = clarificationFrom(chat.turns.at(-1));
  const sendFromComposer = (): Promise<void> => composerSend(chat, ticks.itemIds, clarificationItemIds);

  return (
    <section className="chat-main">
      <div className="chat-log" ref={logRef}>
        {/* Not the greeting: showing "what can I help with?" above a thread the
            customer can already see makes the page look like it forgot them.
            While loading, both it and the thread are absent, so the emptiness is
            brief and states itself. */}
        {chat.loading || chat.turns.length > 0 ? null : <Greeting onPick={chat.setDraft} />}
        {/* Announced, not just drawn: the customer is waiting, and the reason for
            the wait is the whole thing. */}
        {retrying ? (
          <p className="bubble-them" role="status" aria-live="polite">
            Having trouble reading your message - trying once more.
          </p>
        ) : null}
        {chat.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} chat={chat} {...(turn.kind === 'replied' && turn.result.decision === 'denied' ? { onAppeal: (id: string) => handleAppeal(deps, id) } : {})} />
        ))}
      </div>

      <ScopeChips
        order={order}
        scope={claimScope}
        ticks={ticks}
        pending={pendingPickerOpen(chat.turns)}
      />

      {chat.notice ? <p className="muted small">{chat.notice}</p> : null}
      <Composer
        draft={chat.draft}
        busy={chat.busy}
        blocked={chat.blocked}
        closed={chat.closed}
        onDraft={chat.setDraft}
        onSend={sendFromComposer}
        inHandoff={inHandoff}
        onAttachPhoto={() => handleAttachPhoto(deps)}
      />
      {appealState && <p className="muted small">Sending your appeal…</p>}
      {chat.error.length > 0 ? <ErrorNote error={chat.error} /> : null}
    </section>
  );
}

/**
 * The item picker, offered by the assistant inside the conversation.
 *
 * Rendered where the offer sits in the thread rather than over it, because the
 * offer *is* a turn: the customer's message is above it, the answer is below, and
 * the scroll behaves the same as for any other reply. A control that appears over
 * the thread interrupts reading it.
 *
 * Every line is always shown, including the ones already reported. Hiding them
 * would turn the list into a claim about what is still available, which is a
 * different thing from what the customer bought, and a customer who cannot see
 * the lamp cannot tell that it is why their message was capped to the mug.
 */
function ItemOfferBubble({
  offer,
  chat,
  busy,
}: {
  offer: ItemPickerOffer;
  chat: Conversation;
  busy: boolean;
}): ReactNode {
  // Which line they tapped, and that the tap is in flight.
  //
  // A tap is the answer to a question, so it has to look like one: acknowledged
  // immediately, visibly locked while the next turn is on its way, and left showing
  // afterwards so a reload does not present the same unanswered question again.
  const [chosen, setChosen] = useState<string | null>(null);
  const firstLine = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the first line the customer can actually choose. They have just been asked
    // a question and the answer is a list; moving the caret into it is the difference
    // between answering and hunting for the control. `preventScroll` because the thread
    // has just scrolled itself to the bottom.
    firstLine.current?.focus({ preventScroll: true });
  }, []);

  /**
   * A tap is the answer, so it is acknowledged before it is sent.
   *
   * `chosen` is set first and the request second: the customer sees their own choice
   * land instantly, and the buttons lock behind it so a double-tap cannot send two
   * scopes for one question.
   */
  function answerAs(key: string, itemIds: readonly string[], text: string): void {
    setChosen(key);
    void chat.send(itemIds, text);
  }

  return (
    <div
      className="bubble-them item-choice-prompt"
      role="group"
      aria-label="Choose the item this is about"
      data-offer-id={offer.orderId}
    >
      <OfferCaption answered={chosen !== null} />
      <ul className="item-choice-list">
        {offer.items.map((item, index) => (
          <li key={item.itemId}>
            <ItemChoiceButton
              item={item}
              first={index === 0}
              lineRef={firstLine}
              busy={busy}
              locked={chosen !== null}
              chosen={chosen === item.itemId}
              onPick={() => answerAs(item.itemId, [item.itemId], `It is about the ${item.name}`)}
            />
          </li>
        ))}
      </ul>
      {/* The way out, always. "The whole order" is a claim a customer makes by
          ticking nothing, and it is the only claim available once every line is
          disabled - without this the picker is a dead end and the message behind it
          can never be sent. */}
      <ul className="item-choice-list">
        <li>
          <button
            type="button"
            className={chosen === 'all' ? 'item-choice chosen' : 'item-choice'}
            disabled={busy || chosen !== null}
            onClick={() => answerAs('all', [], 'It is about the whole order')}
          >
            <span>None of these - it is about the whole order</span>
          </button>
        </li>
      </ul>
      <OfferFootnote />
    </div>
  );
}

/**
 * The offer's caption, and its live region.
 *
 * Announced rather than merely drawn: the question is new to anyone using a screen
 * reader, and a group that appears without being read is a question nobody was asked.
 * After the tap it says what is happening instead of repeating the question, so the
 * answer and the confirmation are the same sentence.
 */
function OfferCaption({ answered }: { answered: boolean }): ReactNode {
  return (
    <p role="status" aria-live="polite">
      {answered
        ? 'Got it - checking the policy for that item now.'
        : 'Which item is this about? Pick one and I will check the policy for that item.'}
    </p>
  );
}

/**
 * The note under the offer.
 *
 * Its own component because it is the one part of this bubble that explains a
 * *limit* rather than offering a choice, and it changes only when the offer does.
 */
function OfferFootnote(): ReactNode {
  return (
    <p className="muted small">
      Already-reported items cannot be claimed again here. You can report a different problem with one in a new conversation.
    </p>
  );
}

/**
 * One line of the offer.
 *
 * Its own component so the offer reads as a question and its answers, rather than as
 * a wall of markup: every button here has four states (available, already reported,
 * tapped, and locked-because-something-else-was) and only the last two are easy to
 * miss when they are inline.
 */
function ItemChoiceButton({
  item,
  first,
  lineRef,
  busy,
  locked,
  chosen,
  onPick,
}: {
  item: ItemChoice;
  first: boolean;
  lineRef: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  locked: boolean;
  chosen: boolean;
  onPick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      ref={first ? lineRef : undefined}
      className={chosen ? 'item-choice chosen' : 'item-choice'}
      disabled={busy || item.reported || locked}
      onClick={onPick}
    >
      <span>
        {item.name}
        {item.quantity > 1 ? ` ×${item.quantity}` : ''}
        {item.reported ? ' · already reported' : ''}
        {chosen ? ' · checking' : ''}
      </span>
      <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
    </button>
  );
}

/**
 * Whether the thread is sitting on an unanswered offer.
 *
 * The chips below the composer stand down while it is, so the customer is never
 * given two places to say the same thing about the same order.
 */
function pendingPickerOpen(turns: readonly Turn[]): boolean {
  const last = turns.at(-1);
  return last !== undefined && (last.kind === 'asked' || last.kind === 'storedAsk') && last.picker !== null;
}

/**
 * Optional per-line scope, under the composer.
 *
 * The assistant normally asks which item is at issue, and that is the path worth
 * defaulting to. These chips exist because "proactively" and "only when asked" are
 * different products: a customer who knows exactly which line is wrong should not
 * have to wait to be offered a choice they were already going to make. They are a
 * modifier on the message, never a gate in front of it.
 */
function ScopeChips({
  order,
  scope,
  ticks,
  pending,
}: {
  order: ShopOrder | null;
  scope: ClaimScope;
  ticks: ItemTicks;
  pending: boolean;
}): ReactNode {
  if (order === null || order.items.length <= 1 || pending) {
    return null;
  }
  const settled = new Set(scope.settled);
  const awaiting = new Set(scope.awaiting);
  return (
    <div className="scope-chips">
      <span className="muted small">About a specific item?</span>
      {order.items.map((item) => (
        <button
          key={item.itemId}
          type="button"
          className="chip"
          aria-pressed={ticks.itemIds.includes(item.itemId)}
          // Only a decided line is closed. A line waiting on a person stays open,
          // because the customer is mid-conversation about it and being told "you may
          // not discuss this item" is the opposite of what happened.
          disabled={settled.has(item.itemId)}
          onClick={() => ticks.toggle(item.itemId)}
        >
          {item.name}
          {awaiting.has(item.itemId) ? <span className="muted small"> · with a person</span> : null}
        </button>
      ))}
      {ticks.itemIds.length > 0 ? (
        <button type="button" className="chip" onClick={() => ticks.clear()}>
          Clear
        </button>
      ) : null}
    </div>
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
/**
 * The thread's socket.
 *
 * Most events mean the stored thread changed, so the page re-reads it - one path for
 * every event, because a re-read cannot be wrong about what is in storage. The
 * exception is `assistant.retrying`, which describes something happening *now* and
 * is not in storage: it raises a status line for as long as the request is in
 * flight, so a customer waiting through a retry sees why rather than watching a
 * spinner and guessing.
 */
function useShopSocket(customerId: string | null, onEvent: () => void, onRetrying: () => void): void {
  const handler = useRef(onEvent);
  const retrying = useRef(onRetrying);

  // Written in an effect, not during render: a ref that is updated while the
  // component draws can be stale for a render the socket fires between, and it
  // is what the refs rule is about.
  useEffect(() => {
    handler.current = onEvent;
    retrying.current = onRetrying;
  }, [onEvent, onRetrying]);

  useEffect(() => {
    if (customerId === null) {
      return;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/shop/chat/ws`);
    socket.onmessage = (event: MessageEvent<string>) => {
      if (isRetryingEvent(event.data)) {
        retrying.current();
        return;
      }
      handler.current();
    };
    // `onclose` needs no special handling: the thread is re-read on every event,
    // so a dropped socket costs nothing but the notice arriving later.
    return () => socket.close();
  }, [customerId]);
}

/** Read off the wire without trusting it: a message we cannot read is a re-read. */
function isRetryingEvent(data: string): boolean {
  try {
    const parsed: unknown = JSON.parse(data);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { readonly type?: unknown }).type === 'assistant.retrying'
    );
  } catch {
    return false;
  }
}

/**
 * Keeps the thread pinned to its newest turn.
 *
 * Its own hook because the thread component is about *what* is in the log and this is
 * about *where the log is scrolled*, and those two change for different reasons: a new
 * turn arrives, or the window resizes.
 */
function useScrollToBottom(turns: readonly Turn[]): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const log = ref.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [turns]);

  return ref;
}

/**
 * Which lines are done with, and which are still with a person.
 *
 * A line is settled only when a request about it reached a final outcome - approved,
 * refunded in part, or refused. A line on an *escalated* request is still in play:
 * nobody has decided it, so the customer keeps the ability to say more about it, and
 * is told why rather than being left to guess.
 */
/** Which lines are done with, and which are still with a person. */
interface ClaimScope {
  readonly settled: readonly string[];
  readonly awaiting: readonly string[];
}

function claimState(turns: readonly Turn[]): ClaimScope {
  const settled = new Set<string>();
  const awaiting = new Set<string>();
  for (const turn of turns) {
    if (turn.kind !== 'replied' && turn.kind !== 'stored') {
      continue;
    }
    // `ReplyBody` flattens the decision to its value, so this is a string and not a
    // nested object.
    const outcome = turn.result.decision;
    const target = outcome === 'escalated' ? awaiting : settled;
    for (const itemId of turn.result.itemIds ?? []) {
      target.add(itemId);
    }
  }
  return { settled: [...settled], awaiting: [...awaiting] };
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
}: {
  orders: readonly ShopOrder[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  order: ShopOrder | null;
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
    </div>
  );
}

/**
 * Catalogue search beside the shopping thread.
 *
 * A shortcut, not the assistant: typing here never sends a message, it only
 * fills the cart. Anything needing words - tracking, returns, advice - goes
 * through the composer so the answer is persisted in the thread.
 */
function ShoppingPanel(): ReactNode {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Product[]>([]);
  const [error, setError] = useState('');

  async function search(): Promise<void> {
    const text = query.trim();
    if (text.length === 0) {
      return;
    }
    try {
      const found = await shopApi.searchProducts(text, { limit: 6 });
      setResults(found.products);
      setError('');
    } catch (cause: unknown) {
      setError(describe(cause));
    }
  }

  return (
    <div className="order-scope">
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="stack-sm">
          <span className="label">Search the catalogue</span>
          <input
            value={query}
            maxLength={200}
            aria-label="Search the catalogue"
            placeholder="Lamp, mug, kettle…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" className="button-secondary small">
          Search
        </button>
      </form>
      {error.length > 0 ? <ErrorNote error={error} /> : null}
      {results.length > 0 ? (
        <ul className="lines">
          {results.map((item) => (
            <li key={item.id}>
              <span>
                {item.name} <span className="num">{money(item.priceCents)}</span>
              </span>
              <button type="button" className="chip" onClick={() => addToCart(item.id)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      ) : null}
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

function TurnView({
  turn,
  chat,
  onAppeal,
}: {
  turn: Turn;
  chat: Conversation;
  onAppeal?: (requestId: string) => void | Promise<void>;
}): ReactNode {
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
    return <QuestionBubble turn={turn} chat={chat} />;
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
        {/* A message handed to a person and not yet answered. Saying so is the
            whole difference between "someone has this" and "this is broken": the
            message was kept and a person will reply, and silence is the one thing
            that is actually wrong here. */}
        {turn.waitingForPerson ? (
          <p className="muted small">Sent to the agent reviewing this. Nothing else is needed.</p>
        ) : null}
      </>
    );
  }
  return <AgentReply text={turn.text} media={turn.media ?? null} />;
}

function QuestionBubble({
  turn,
  chat,
}: {
  turn: Turn & { kind: 'storedAsk' | 'asked' };
  chat: Conversation;
}): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      {turn.picker === null ? (
        <Question reply={turn.question} />
      ) : (
        <ItemOfferBubble offer={turn.picker} chat={chat} busy={chat.busy} />
      )}
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
        {result.decision === 'approved' || result.decision === 'partial_refund' ? (
          <strong>{formatCents(result.refundAmountCents)}</strong>
        ) : null}
        {result.decision === 'escalated' ? (
          <span className="muted">Someone confirms this by hand before anything is paid.</span>
        ) : null}
        {result.decision === 'exchange' || result.decision === 'store_credit' ? (
          <span className="muted">No money is moved by this.</span>
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
