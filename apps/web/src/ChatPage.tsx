import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, Headset, Send, ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import { ErrorNote } from './components';
import { formatCents } from './format';
import { api } from './api';
import { useConversation, type Conversation, type ReplyBody, type Turn } from './useConversation';
import { money, shopApi, describe, type ShopOrder } from './shop/api';
import { useAsyncData } from './shop/hooks';
import { reasonFor, REASONS } from './shop/issueReasons';
import type { DuplicateNotice, ItemChoice, ItemPickerOffer } from './api';
import type { CustomerFork } from './shop/api';
import { ForkPanel, forkTitle, useForkList } from './ForkPanel';

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
  const selected = useSelectedOrder(orderList, handoffOrderId(handoff));
  const context = useMemo(
    () => helpContext(orderList, selected.orderId),
    [orderList, selected.orderId],
  );
  const chat = useConversation(
    customerId,
    context.chatOrderId,
    complaintFor(handoff?.issue ?? null),
  );
  // Settled and awaiting are different things, and treating them as one cost the
  // customer the ability to talk about the item they had just complained about: an
  // escalation marks its lines as reported, so after the first "it needs a person"
  // every option greyed out except lines nobody had claimed - which reads as "you
  // may only complain about the subscription".
  const claimScope = useMemo(() => claimState(chat.turns), [chat.turns]);
  // A deep link from the order's report wizard names the line: it arrives
  // ticked, and the derived filter below still drops it when it is not on
  // this order or is already decided, so a crafted URL cannot widen scope.
  const initialTicks = handoff !== null && handoff.itemId !== null ? [handoff.itemId] : [];
  const ticks = useItemTicks(context.order, claimScope.settled, initialTicks);
  // Forks live beside the thread: when this order's case is with a person, the
  // composer's wait text points at the side panel instead of a bare wait, and
  // names the case so a second escalation does not read as the first one again.
  const forkState = useForkList(customerId);
  const threadChat = chatWithForkNotice(forkState.forks, context.chatOrderId, chat);

  return (
    <div className="chat-layout">
      <HelpAside
        orders={orderList}
        ordersLoading={orders.data === null && orders.error === null}
        selected={selected.orderId}
        onSelect={selected.select}
        order={context.order}
      />

      <ChatThread
        chat={threadChat}
        order={context.order}
        ticks={ticks}
        claimScope={claimScope}
      />

      <ForkPanel forks={forkState.forks} generation={forkState.generation} refresh={forkState.refresh} socketError={forkState.socketError} />
    </div>
  );
}

/**
 * The thread's wait text, fork-aware.
 *
 * A bare "someone is picking this up" sends the customer back to the one box
 * they cannot use. When this order's case is the one with a person, the text
 * names the case and points at the side panel instead; every other wait -
 * legacy takeovers with no panel, closed threads - keeps the server's wording.
 */
function chatWithForkNotice(
  forks: readonly CustomerFork[],
  chatOrderId: string | null,
  chat: Conversation,
): Conversation {
  if (chat.blocked === null) {
    return chat;
  }
  const orderFork = forks.find((fork) => fork.orderId === chatOrderId);
  if (orderFork === undefined) {
    return chat;
  }
  return {
    ...chat,
    blocked: `${forkTitle(orderFork)} is with a person — write to them in the panel. Your other orders still work here.`,
  };
}

/**
 * The page's sidelong half: title and whichever context the page needs - the
 * order picker for support.
 *
 * Split out because the page owns the mode and the thread owns the scroll, and
 * neither should also own this markup: a page that renders everything it knows
 * in one function stops being readable at exactly this size.
 */
function HelpAside({
  orders,
  ordersLoading,
  selected,
  onSelect,
  order,
}: {
  orders: readonly ShopOrder[];
  ordersLoading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  order: ShopOrder | null;
}): ReactNode {
  return (
    <aside className="chat-context">
      <h1>Get help with an order</h1>
      <OrderScope orders={orders} loading={ordersLoading} selected={selected} onSelect={onSelect} order={order} />
      <AssistantStatus />
    </aside>
  );
}

/**
 * Which conversation this box holds.
 *
 * A lens for the customer rather than a promise about which pipeline answers:
 * the server re-classifies every message either way.
 */

/**
 * The order the thread is about, or none if none is selected.
 *
 * The server classifies each message on its own. Support keeps the handoff-then
 * latest-order default from the picker below.
 */
function orderForMode(
  orders: readonly ShopOrder[],
  selectedId: string | null,
): ShopOrder | null {
  return orders.find((candidate) => candidate.id === selectedId) ?? null;
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

function useItemTicks(
  order: ShopOrder | null,
  reportedItemIds: readonly string[] = [],
  initialItemIds: readonly string[] = [],
): ItemTicks {
  const [chosen, setChosen] = useState<readonly string[]>(initialItemIds);
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
      const result = reader.result;
      if (typeof result !== 'string') {
        alert('Could not read that image file.');
        return;
      }
      const dataUrl = result;
      const requestTurn = deps.chat.turns.find((t) => t.kind === 'replied' || t.kind === 'stored');
      const orderId = requestTurn ? null : undefined;
      try {
        await shopApi.chatMedia({ orderId: orderId ?? null, caption: '', media: { dataUrl } });
        deps.chat.refresh();
      } catch (cause) {
        alert(describe(cause));
      }
    };
    reader.onerror = () => {
      alert('Could not read that image file.');
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

/** The reply to stream: the trailing assistant turn, unless it was there on arrival. */
function latestStreamableTurnId(turns: readonly Turn[], initialIds: ReadonlySet<string>): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) {
      continue;
    }
    if (!isStreamable(turn)) {
      return null;
    }
    return initialIds.has(turn.id) ? null : turn.id;
  }
  return null;
}

/** The turn ids present on arrival, snapshotted once the thread first has turns. */
function useInitialTurnIds(turns: readonly Turn[], loading: boolean): ReadonlySet<string> | null {
  const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(null);
  if (initialIds === null && !loading && turns.length > 0) {
    setInitialIds(new Set(turns.map((turn) => turn.id)));
  }
  return initialIds;
}

/** This order's verdicts plus an optimistic local layer, for the thumbs. */
function useReplyRatings(orderId: string | null): {
  ratingFor: (requestId: string) => Rating | null;
  castRate: (requestId: string, rating: Rating) => void;
} {
  const ratings = useAsyncData(
    () =>
      orderId === null
        ? Promise.resolve({ ratings: [] as readonly { requestId: string; rating: Rating }[] })
        : shopApi.orderRatings(orderId),
    [orderId],
  );
  const ratingMap = useMemo(
    () => new Map((ratings.data?.ratings ?? []).map((row) => [row.requestId, row.rating] as const)),
    [ratings.data],
  );
  const [votes, setVotes] = useState<Readonly<Record<string, Rating>>>({});
  const castRate = (requestId: string, rating: Rating): void => {
    setVotes((previous) => ({ ...previous, [requestId]: rating }));
    void shopApi.rateReply(requestId, rating).then(
      () => {
        ratings.reload();
      },
      () => {
        // The vote stays local: the next thread read reconciles it, and a
        // failed vote must not unwind the thumb the customer just set.
      },
    );
  };
  return {
    ratingFor: (requestId: string): Rating | null => votes[requestId] ?? ratingMap.get(requestId) ?? null,
    castRate,
  };
}

function ChatThread({
  chat,
  order,
  ticks,
 
}: {
  chat: Conversation;
  order: ShopOrder | null;
  ticks: ItemTicks;
  /** Which lines are done with, and which are still with a person. */
  claimScope: ClaimScope;
}): ReactNode {
  const logRef = useScrollToBottom(chat.turns);
  const inHandoff = chat.turns.some((turn) => turn.kind === 'handoff');

  const [appealState, setAppealState] = useState<{ requestId: string; reason: string; submitting: boolean } | null>(null);

  const deps: ChatThreadDeps = { chat, inHandoff, appealState, setAppealState };
  const clarificationItemIds = clarificationFrom(chat.turns.at(-1));
  const sendFromComposer = (): Promise<void> => composerSend(chat, ticks.itemIds, clarificationItemIds);

  // Turns present on arrival render instantly; only a reply that lands while
  // watching streams in. The snapshot is taken once the thread first has
  // turns rather than on mount, because the thread loads asynchronously -
  // snapshotting the empty loading state would replay the whole history
  // typing itself out. Without it, every reload would do exactly that.
  const initialIds = useInitialTurnIds(chat.turns, chat.loading);
  const streamId = useMemo(
    () => (initialIds === null ? null : latestStreamableTurnId(chat.turns, initialIds)),
    [chat.turns, initialIds],
  );
  const seenId = useMemo(() => seenTurnId(chat.turns), [chat.turns]);
  const { ratingFor, castRate } = useReplyRatings(order?.id ?? null);

  return (
    <section className="chat-main">
      <div className="chat-log" ref={logRef}>
        {/* Not the greeting: showing "what can I help with?" above a thread the
            customer can already see makes the page look like it forgot them.
            While loading, both it and the thread are absent, so the emptiness is
            brief and states itself. */}
        {chat.loading || chat.turns.length > 0 ? null : <Greeting onPick={chat.setDraft} />}
        <ThreadTurns
          chat={chat}
          streamId={streamId}
          seenId={seenId}
          ratingFor={ratingFor}
          castRate={castRate}
          deps={deps}
        />
        {chat.busy && !chat.turns.some((turn) => turn.kind === 'pending') ? <TypingBubble /> : null}
      </div>

     

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

/** The scrollable turns: streamed arrivals, read marks, and the typing bubble. */
function ThreadTurns({
  chat,
  streamId,
  seenId,
  ratingFor,
  castRate,
  deps,
}: {
  chat: Conversation;
  streamId: string | null;
  seenId: string | null;
  ratingFor: (requestId: string) => Rating | null;
  castRate: (requestId: string, rating: Rating) => void;
  deps: ChatThreadDeps;
}): ReactNode {
  return (
    <>
      {chat.turns.map((turn) => (
        <Fragment key={turn.id}>
          <TurnView
            turn={turn}
            chat={chat}
            stream={turn.id === streamId}
            rating={ratingFor(turn.id)}
            {...appealFor(turn, (id: string) => handleAppeal(deps, id))}
            onRate={castRate}
          />
          {turn.id === seenId ? <p className="seen">Seen</p> : null}
        </Fragment>
      ))}
      {chat.busy && !chat.turns.some((turn) => turn.kind === 'pending') ? <TypingBubble /> : null}
    </>
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
 * the page says so, because "the assistant is not working"
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
          You have not bought anything yet, so there is nothing to check a refund against.
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
 * The order the thread is about, with the id the conversation hook needs.
 *
 * One derivation so the page does not repeat it: support resolves the selected order
 * and names it for the thread that follows.
 */
function helpContext(
  orders: readonly ShopOrder[],
  selectedId: string | null,
): { readonly order: ShopOrder | null; readonly chatOrderId: string | null } {
  const order = orderForMode(orders, selectedId);
  return { order, chatOrderId: order === null ? null : order.id };
}

/** The order the Orders page handed over, if any. */
function handoffOrderId(handoff: { readonly orderId: string } | null): string | null {
  return handoff === null ? null : handoff.orderId;
}

/**
 * The order the Orders page handed over, if any.
 *
 * Only the id travels. The reason travels as an id too, and the wording is
 * rebuilt here from the shared list rather than trusted from the URL - a link is
 * not a place to put a sentence a customer will then read as something they
 * said.
 */
function useHandoff(): { readonly orderId: string; readonly issue: string | null; readonly itemId: string | null } | null {
  const [params] = useSearchParams();
  const orderId = params.get('order');
  if (orderId === null) {
    return null;
  }
  return { orderId, issue: params.get('issue'), itemId: params.get('item') };
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
  const status = useAsyncData(() => api.health(), ['assistant-status']);
  if (status.data === null) {
    return null;
  }
  const { aiMode, aiAvailable, aiUnavailableReason: aiNote } = status.data;
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
  placeholder = 'Describe what went wrong…',
}: {
  draft: string;
  busy: boolean;
  blocked: string | null;
  closed: boolean;
  onDraft: (next: string) => void;
  onSend: () => Promise<void>;
  inHandoff: boolean;
  onAttachPhoto: () => void;
  placeholder?: string;
}): ReactNode {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
    >
      <label className="chat-composer-label" htmlFor="chat-message">Your message</label>
      <input
        id="chat-message"
        value={draft}
        maxLength={4000}
        aria-label="Describe the problem"
        placeholder={placeholder}
        disabled={closed}
        onChange={(event) => onDraft(event.target.value)}
      />
      {inHandoff ? (
        <PhotoAttachButton busy={busy} closed={closed} onAttachPhoto={onAttachPhoto} />
      ) : null}
      <button type="submit" disabled={busy || blocked !== null} aria-label="Send">
        <Send size={16} />
        <span className="sr-only">Send</span>
      </button>
      {blocked !== null ? <p className="muted small">{blocked}</p> : null}
    </form>
  );
}

function PhotoAttachButton({
  busy,
  closed,
  onAttachPhoto,
}: {
  busy: boolean;
  closed: boolean;
  onAttachPhoto: () => void;
}): ReactNode {
  return (
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
  );
}

/**
 * The chat comforts: streaming replies, copying, rating, and read receipts.
 *
 * All presentation, none of it policy: the reply text is the same string the
 * server returned either way, and nothing here changes what was decided or
 * sent. Streaming covers hardcoded and model-written replies alike, because
 * both arrive as finished text and both are read as they appear.
 */

/** Characters per streaming tick, and the tick length. */
const STREAM_CHUNK_DIVISOR = 30;
const STREAM_TICK_MS = 8;

function useReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Typewriter reply text. Renders instantly when there is nothing to stream. */
export function StreamedText({ text, stream }: { text: string; stream: boolean }): ReactNode {
  const reduceMotion = useReducedMotion();
  const active = stream && !reduceMotion;
  const [shown, setShown] = useState(() => (active ? 0 : text.length));
  // A newer turn landing above flips stream off for the same text: derived
  // during render (the sanctioned alternative to setting state in an effect),
  // so a reply behind a newer one jumps to full instead of freezing mid-type.
  const [epoch, setEpoch] = useState({ text, active });
  if (epoch.text !== text || epoch.active !== active) {
    setEpoch({ text, active });
    setShown(active ? 0 : text.length);
  }
  useEffect(() => {
    if (!active) {
      return;
    }
    const step = Math.max(1, Math.ceil(text.length / STREAM_CHUNK_DIVISOR));
    const timer = window.setInterval(() => {
      setShown((n) => {
        const next = n + step;
        if (next >= text.length) {
          window.clearInterval(timer);
          return text.length;
        }
        return next;
      });
    }, STREAM_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, text]);
  return <>{text.slice(0, shown)}</>;
}

/** Copy-to-clipboard with a brief confirmation. Best-effort by design. */
export function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );
  const copy = async (): Promise<void> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('no clipboard API');
      }
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      } catch {
        // Clipboard unavailable: the label still flips, because the
        // alternative is a button that silently does nothing.
      }
    }
    setCopied(true);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={copied ? 'Copied to clipboard' : label}
      title={copied ? 'Copied' : label}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

export type Rating = 'up' | 'down';

/** Thumbs on an answer. The vote persists server-side; this only casts it. */
export function RateWidget({
  requestId,
  rating,
  onRate,
}: {
  requestId: string;
  rating: Rating | null;
  onRate: (requestId: string, rating: Rating) => void;
}): ReactNode {
  return (
    <span className="rate-row" role="group" aria-label="Rate this answer">
      <button
        type="button"
        className="icon-btn"
        aria-label="Helpful answer"
        aria-pressed={rating === 'up'}
        onClick={() => onRate(requestId, 'up')}
      >
        <ThumbsUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Unhelpful answer"
        aria-pressed={rating === 'down'}
        onClick={() => onRate(requestId, 'down')}
      >
        <ThumbsDown size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

/** Turn kinds that carry the customer's own words. */
function hasCustomerText(turn: Turn): boolean {
  return (
    turn.kind === 'pending' ||
    turn.kind === 'agent' ||
    turn.kind === 'asked' ||
    turn.kind === 'storedAsk' ||
    turn.kind === 'stored' ||
    turn.kind === 'replied'
  );
}

/** Turn kinds that answer the customer. */
function isAssistantAnswer(turn: Turn): boolean {
  if (turn.kind === 'agent') {
    return turn.sender !== 'customer';
  }
  return (
    turn.kind === 'replied' ||
    turn.kind === 'stored' ||
    turn.kind === 'asked' ||
    turn.kind === 'storedAsk' ||
    turn.kind === 'update'
  );
}

/**
 * The id of the latest customer message that has been answered, if any.
 *
 * Derived, never stored: a server-kept "seen" would need a write on every
 * read and a definition of reading, while the thread already shows the truth.
 * Most turns bundle both sides - a reply carries the message it answers - so
 * those count as answered by themselves; a bare customer message (just sent,
 * or written to a person) needs a later assistant turn after it. Only the
 * newest answered message carries the mark.
 */
function seenTurnId(turns: readonly Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || !hasCustomerText(turn)) {
      continue;
    }
    if (turn.kind !== 'pending' && !(turn.kind === 'agent' && turn.sender === 'customer')) {
      return turn.id;
    }
    for (let after = index + 1; after < turns.length; after += 1) {
      const later = turns[after];
      if (later !== undefined && isAssistantAnswer(later)) {
        return turn.id;
      }
    }
    return null;
  }
  return null;
}

/** Turn kinds whose assistant text may stream in. Human-written turns never stream. */
function isStreamable(turn: Turn): boolean {
  return (
    turn.kind === 'replied' ||
    turn.kind === 'stored' ||
    turn.kind === 'asked' ||
    turn.kind === 'storedAsk'
  );
}

function TurnView({
  turn,
  chat,
  stream,
  rating,
  onAppeal,
  onRate,
}: {
  turn: Turn;
  chat: Conversation;
  stream: boolean;
  rating: Rating | null;
  onAppeal?: (requestId: string) => void | Promise<void>;
  onRate?: ((requestId: string, rating: Rating) => void) | undefined;
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
    return (
      <StoredDecisionBubble
        turn={turn}
        stream={stream}
        rating={rating}
        onRate={onRate}
        {...appealProps(onAppeal)}
      />
    );
  }
  if (turn.kind === 'storedAsk' || turn.kind === 'asked') {
    return <QuestionBubble turn={turn} chat={chat} stream={stream} />;
  }
  return (
    <LiveDecisionBubble
      turn={turn}
      stream={stream}
      rating={rating}
      onRate={onRate}
      {...appealProps(onAppeal)}
    />
  );
}

/** The appeal control, only where a refusal can carry one. Absent otherwise. */
function appealProps(
  onAppeal: ((requestId: string) => void | Promise<void>) | undefined,
): { onAppeal?: (requestId: string) => void | Promise<void> } {
  return onAppeal === undefined ? {} : { onAppeal };
}

/**
 * Which turns carry an appeal control.
 *
 * Live and stored denials alike: the refusal used to be appealable only in
 * the session that produced it, so a reload silently removed the one way to
 * contest it. Anything else - approvals, questions - has nothing to appeal,
 * and the control stays absent.
 */
function appealFor(
  turn: Turn,
  onAppeal: (requestId: string) => void | Promise<void>,
): { onAppeal?: (requestId: string) => void | Promise<void> } {
  if (turn.kind === 'replied' && turn.result.decision === 'denied') {
    return { onAppeal };
  }
  if (turn.kind === 'stored' && turn.result.decision === 'denied') {
    return { onAppeal };
  }
  return {};
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
  stream,
}: {
  turn: Turn & { kind: 'storedAsk' | 'asked' };
  chat: Conversation;
  stream: boolean;
}): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      {turn.picker === null ? (
        <Question reply={turn.question} stream={stream} />
      ) : (
        <ItemOfferBubble offer={turn.picker} chat={chat} busy={chat.busy} />
      )}
    </>
  );
}

function StoredDecisionBubble({
  turn,
  stream,
  rating,
  onAppeal,
  onRate,
}: {
  turn: Turn & { kind: 'stored' };
  stream: boolean;
  rating: Rating | null;
  onAppeal?: (requestId: string) => void | Promise<void>;
  onRate?: ((requestId: string, rating: Rating) => void) | undefined;
}): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Reply
        result={turn.result}
        duplicate={null}
        requestId={turn.id}
        stream={stream}
        rating={rating}
        {...(onAppeal !== undefined ? { onAppeal } : {})}
        {...(onRate !== undefined ? { onRate } : {})}
      />
    </>
  );
}

function LiveDecisionBubble({
  turn,
  stream,
  rating,
  onAppeal,
  onRate,
}: {
  turn: Turn & { kind: 'replied' };
  stream: boolean;
  rating: Rating | null;
  onAppeal?: (requestId: string) => void | Promise<void>;
  onRate?: ((requestId: string, rating: Rating) => void) | undefined;
}): ReactNode {
  return (
    <>
      <p className="bubble-me">{turn.text}</p>
      <Reply
        result={turn.result}
        duplicate={turn.duplicate}
        requestId={turn.id}
        stream={stream}
        rating={rating}
        {...(onAppeal !== undefined ? { onAppeal } : {})}
        {...(onRate !== undefined ? { onRate } : {})}
      />
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
        <CopyButton text={text} label="Copy agent reply" />
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
function Question({ reply, stream }: { reply: string; stream: boolean }): ReactNode {
  return (
    <div className="bubble-them">
      <p>
        <StreamedText text={reply} stream={stream} />
      </p>
      <div className="row">
        <CopyButton text={reply} label="Copy question" />
      </div>
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
function Reply({
  result,
  duplicate,
  onAppeal,
  requestId,
  stream,
  rating,
  onRate,
}: {
  result: ReplyBody;
  duplicate: DuplicateNotice | null;
  onAppeal?: (requestId: string) => void | Promise<void>;
  requestId?: string;
  stream: boolean;
  rating: Rating | null;
  onRate?: ((requestId: string, rating: Rating) => void) | undefined;
}): ReactNode {
  return (
    <div className="bubble-them">
      <div className="row">

        <span className={`pill pill-${result.decision}`}>{result.decision}</span>
      </div>
      {duplicate === null ? null : (
        <p className="small muted">
          Shown from your request on {new Date(duplicate.firstReportedAt).toLocaleString()}. This is the
          same message, so it was not decided a second time.
        </p>
      )}
      <BlockedItems decision={result.decision} items={result.blockedItems} />
      <p>
        <StreamedText text={result.responseText} stream={stream} />
      </p>
      <ReplyFooter result={result} requestId={requestId} rating={rating} onAppeal={onAppeal} onRate={onRate} />
    </div>
  );
}

/** Everything under an answer's prose: amount, appeal, copy, and thumbs. */
function ReplyFooter({
  result,
  requestId,
  rating,
  onAppeal,
  onRate,
}: {
  result: ReplyBody;
  requestId?: string | undefined;
  rating: Rating | null;
  onAppeal?: ((requestId: string) => void | Promise<void>) | undefined;
  onRate?: ((requestId: string, rating: Rating) => void) | undefined;
}): ReactNode {
  return (
    <footer className="row small">
      <DecisionNote result={result} />
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
      <CopyButton text={result.responseText} label="Copy answer" />
      {requestId !== undefined && onRate !== undefined ? (
        <RateWidget requestId={requestId} rating={rating} onRate={onRate} />
      ) : null}
    </footer>
  );
}

/** The one-line consequence under an answer: amount, wait, or no-money note. */
function DecisionNote({ result }: { result: ReplyBody }): ReactNode {
  if (result.decision === 'approved' || result.decision === 'partial_refund') {
    return <strong>{formatCents(result.refundAmountCents)}</strong>;
  }
  if (result.decision === 'escalated') {
    return <span className="muted">Someone confirms this by hand before anything is paid.</span>;
  }
  if (result.decision === 'exchange' || result.decision === 'store_credit') {
    return <span className="muted">No money is moved by this.</span>;
  }
  return null;
}

/**
 * The lines a mixed-cart decision left out, as chips above the prose.
 *
 * Named once in words and once here so a shopper sees the excluded parts at a
 * glance. Not shown on a `denied` reply: a whole-order refusal must not re-blame
 * items for a reason that was about the order, and an item-scoped refusal
 * already names the line in the reply's own words.
 */
function BlockedItems({
  decision,
  items,
}: {
  decision: ReplyBody['decision'];
  items: ReplyBody['blockedItems'];
}): ReactNode {
  if (decision === 'denied' || items.length === 0) {
    return null;
  }
  return (
    <ul className="blocked-items">
      {items.map((item) => (
        <li key={item.name}>
          <strong>{item.name}</strong>
          <span className="muted"> — {item.reason}</span>
        </li>
      ))}
    </ul>
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

