import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import { api, describe } from './api';
import { shopApi, type ChatTurn as StoredTurn, type ItemPickerOffer } from './shop/api';

/**
 * What the server says about a suppressed repeat.
 *
 * Only set when the message matched one this customer had already sent. The
 * interface has to be here for the reason described on `Turn.replied`: an
 * endpoint that can return a request the caller did not just create is a sharp
 * edge, and this is the edge being declared rather than left to be discovered.
 */
interface DuplicateNotice {
  /** The request that already existed. */
  readonly ofRequestId: string;
  readonly firstReportedAt: string;
  readonly firstDecision: string;
}

/**
 * What a reply is made of for the purpose of rendering it.
 *
 * The narrowest shape that still draws a complete answer, rather than the whole
 * `RefundRequestDto`. Two reasons, and the second is the one that matters:
 *
 *  - The stored half of the thread comes back from `chatHistory` reduced to
 *    exactly these columns. Widening the contract to the full DTO would mean
 *    inventing the rest of it - an eligible amount of zero, an empty trace - so
 *    a remembered decision would display a number nobody ever computed.
 *
 *  - One shape for both halves means a renderer cannot tell by type whether a
 *    decision is the one it just made or one it remembers, so it cannot read a
 *    field by accident that only exists on fresh turns.
 *
 * `refundAmountCents` is the amount authorised for payment and is zero unless
 * the decision is `approved`; what is merely under review is said in words, not
 * by a number that has not been authorised.
 */
export interface ReplyBody {
  readonly decision: RefundRequestDto['decision']['decision'];
  readonly refundAmountCents: number;
  readonly responseText: string;
  readonly itemIds?: readonly string[];
  /**
   * The lines a mixed-cart decision left out, in words the shopper can read.
   *
   * Kept to `name` and `reason` for the reason `ChatTurn.blockedItems` states:
   * the composed reply already quotes both, and `ruleId`/`priceCents` are staff
   * data the thread contract deliberately narrows away.
   */
  readonly blockedItems: readonly { readonly name: string; readonly reason: string }[];
}

/** One customer message and whatever came back for it. */
export type Turn =
  | { readonly kind: 'pending'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'replied';
      readonly id: string;
      readonly text: string;
      readonly result: ReplyBody;
      /**
       * Set when the server recognised a repeat and returned the earlier
       * request instead of deciding again. The UI marks the turn, because
       * returning the same answer twice with no explanation is indistinguishable
       * from the request having failed.
       */
      readonly duplicate: DuplicateNotice | null;
    }
  | {
      /**
       * The assistant asked a clarifying question instead of deciding. A
       * question is not a decision and renders as one - the customer's message
       * and the question it earned - but it settles the turn into its own shape
       * so nothing downstream can mistake a question for an outcome.
       */
      readonly kind: 'asked';
      readonly id: string;
      readonly text: string;
      readonly question: string;
      /**
       * The item picker offered instead of a question, when one was.
       *
       * Rendered from this rather than parsed out of `question`: the offer is the
       * customer's answer surface, and a question the model wrote is not. When it is
       * present the turn renders as buttons; when it is null, as a sentence.
       */
      readonly picker: ItemPickerOffer | null;
      readonly itemIds: readonly string[];
    }
  | {
      /** A turn loaded from storage rather than decided in this session. */
      readonly kind: 'stored';
      readonly id: string;
      readonly text: string;
      readonly result: ReplyBody;
    }
  | {
      /** A stored clarifying question, remembered with the question it asked. */
      readonly kind: 'storedAsk';
      readonly id: string;
      readonly text: string;
      readonly question: string;
      readonly picker: ItemPickerOffer | null;
      readonly itemIds: readonly string[];
    }
  | {
      /**
       * What a person later did about one of the customer's requests, reported
       * in their thread.
       *
       * No `text`, and no `result`, because the customer sent nothing and there
       * is no new decision - the decision was already made, by the person. Only
       * the message, which is why this cannot borrow the shape of a reply
       * without inventing an amount and a status to fill it with.
       */
      readonly kind: 'update';
      readonly id: string;
      readonly text: string;
      readonly ofRequestId: string;
    }
  | {
      /**
       * One message exchanged with a person during a live takeover, told apart
       * by `sender`. The customer's own words render on their side of the
       * thread; the agent's words render with a marker so the customer knows
       * the reply came from a person - the whole reason a takeover happened.
       */
      readonly kind: 'agent';
      readonly id: string;
      readonly text: string;
      readonly sender: 'agent' | 'customer';
      readonly createdAt: string;
      /** Optional photo attached to this message, served under `/media/`. Null for text. */
      readonly media: { readonly type: string; readonly url: string; readonly bytes: number } | null;
      /**
       * True when this message was handed to a person and nothing came back.
       *
       * Carried because without it the customer's own words are the last thing on
       * screen and the thread looks frozen: the message went somewhere, was kept,
       * and is waiting - which is the opposite of a failure, and has to look like
       * it.
       */
      readonly waitingForPerson?: boolean;
    }
  | {
      /**
       * The moment a person took over the thread, rendered as the notice the
       * customer was told. Derived from the takeover row, so it is only in the
       * history while the takeover is actually live.
       */
      readonly kind: 'handoff';
      readonly id: string;
      readonly text: string;
    };

export interface Conversation {
  readonly turns: readonly Turn[];
  readonly closed: boolean;
  readonly draft: string;
  readonly busy: boolean;
  readonly error: string;
  /** Why the composer will not send, or null when it will. */
  readonly blocked: string | null;
  /**
   * What the server had to do to answer, in one sentence, when it had to do
   * something worth explaining: a retry that worked, a matcher reading the message
   * instead of a model, or a claim nobody could read. Null in the ordinary case.
   *
   * Kept separate from the reply text because it is not part of the answer. The
   * customer should be able to learn that their message was read another way without
   * the refund notice having to say so, and an operator should be able to read it in
   * the thread rather than inferring it from the decision.
   */
  readonly notice: string | null;
  /**
   * A person is holding the thread and has not answered yet.
   *
   * The composer closes while it is true. A customer typing into a thread a person is
   * about to answer collects messages nobody has read yet, and the box opening again
   * on their reply is the signal that it is their turn.
   */
  readonly awaitingPerson: boolean;
  /** True while an order's stored history is loading. */
  readonly loading: boolean;
  readonly setDraft: (next: string) => void;
  /**
   * Sends the draft, scoped to `itemIds`.
   *
   * `text` overrides the draft, and exists for one caller: a tap on the item
   * picker, which answers a question already asked. By the time the offer is on
   * screen the customer's original message has been sent and the draft is empty,
   * so a tap needs a sentence of its own to send. It is a short deterministic one
   * naming the line, rather than the original message replayed - replaying it
   * would be a second request with identical text, which the duplicate check
   * would suppress, leaving the customer tapping a button that does nothing.
   */
  readonly send: (itemIds?: readonly string[], text?: string) => Promise<void>;
  /** Re-reads the stored thread: the socket tells us something changed. */
  readonly refresh: () => void;
}

/** Turns held in this session, per order. See `useLiveTurns`. */
type TurnBuckets = Readonly<Record<string, readonly Turn[]>>;

/** The history loaded so far, tagged with the order it belongs to. */
interface LoadedThread {
  readonly orderId: string;
  readonly turns: readonly Turn[];
  readonly closed: boolean;
  /** Server-authoritative: a person is holding the thread and has not replied yet. */
  readonly awaitingPerson: boolean;
}

/**
 * Why the composer is closed, or null when it is not.
 *
 * Three reasons, in the order they are worth saying. A person holding the thread
 * comes first because it is the only one that reverses: it closes while they have
 * not replied and opens again the moment they do, so it is a wait rather than an
 * ending - and telling someone a conversation is "closed" while a person is about to
 * answer it is the fastest way to lose them.
 */
function blockedBecause(
  awaitingPerson: boolean,
  closed: boolean,
  customerId: string | null,
  orderId: string | null,
): string | null {
  if (awaitingPerson) {
    return 'Someone is picking this up. You can write again as soon as they reply.';
  }
  if (closed) {
    return 'This conversation is closed after the final decision. You can no longer send messages on this order.';
  }
  if (customerId === null) {
    return 'Sign in and the assistant can look up your orders.';
  }
  if (orderId === null) {
    return 'Choose the order you are asking about.';
  }
  return null;
}

/**
 * The order's own conversation, loaded from the server.
 *
 * Turns used to live only in the page, which meant a refresh threw the
 * conversation away and switching to another order and back left an empty box -
 * the customer could not see that the mug was already being refunded, and
 * re-asking about it looked like a system that had forgotten them.
 *
 * The loaded thread is tagged with the order it came from rather than cleared
 * when the selection changes. That is what lets the state be *derived* instead
 * of reset: whether the stored turns apply is a question answered while
 * rendering, so nothing has to be written back to catch up with the new order.
 * An effect that clears state when the id changes is an effect that renders
 * once with the old order's history still on screen.
 *
 * An in-flight load is dropped if its order is no longer the selected one, and
 * the response is additionally checked against the order it was asked for -
 * a slow answer to a question about a different order is worse than no answer.
 */
function useStoredThread(
  customerId: string | null,
  orderId: string | null,
): {
  readonly turns: readonly Turn[];
  readonly closed: boolean;
  readonly awaitingPerson: boolean;
  readonly loading: boolean;
  readonly error: string;
  readonly reload: () => void;
} {
  const [loaded, setLoaded] = useState<LoadedThread | null>(null);
  const [failed, setFailed] = useState<string>('');
  // Bumped by `reload`. The socket announces "something changed, come look";
  // that announcement is not itself a turn, it is a reason to re-read storage -
  // the thread the customer and any agent see must come from the same query.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (customerId === null) {
      return;
    }
    if (orderId === null) {
      return;
    }
    return loadOrderThread(orderId, setLoaded, setFailed);
  }, [customerId, orderId, version]);

  const applies = threadApplies(loaded, orderId);
  const loading = !applies && failed === '' && customerId !== null && orderId !== null;
  const reload = (): void => {
    setVersion((v) => v + 1);
  };
  if (!applies || loaded === null) {
    return { turns: [], closed: false, awaitingPerson: false, loading, error: failed, reload };
  }
  return {
    turns: loaded.turns,
    closed: loaded.closed,
    awaitingPerson: loaded.awaitingPerson,
    loading: false,
    error: failed,
    reload,
  };
}

/** Whether the loaded thread belongs to the current selection. */
function threadApplies(loaded: LoadedThread | null, orderId: string | null): boolean {
  if (loaded === null) {
    return false;
  }
  return loaded.orderId === orderId;
}

type ThreadSetter = Dispatch<SetStateAction<LoadedThread | null>>;
type FailedSetter = Dispatch<SetStateAction<string>>;

/** One order's thread from its two tables, in the order it happened. */
function mergeThreadTurns(
  chat: readonly StoredTurn[],
): readonly Turn[] {
  const stamped: { createdAt: string; turn: Turn }[] = chat.map((turn) => ({ createdAt: turn.createdAt, turn: toTurn(turn) }));
  stamped.sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return 0;
    }
    return a.createdAt < b.createdAt ? -1 : 1;
  });
  return stamped.map((entry) => entry.turn);
}

/** One order-thread read, dropped when the selection moves underneath it. */
function loadOrderThread(
  orderId: string,
  setLoaded: ThreadSetter,
  setFailed: FailedSetter,
): () => void {
  let current = true;
  shopApi
    .chatHistory(orderId)
    .then((result) => {
      if (current && result.orderId === orderId) {
        setLoaded({
          orderId,
          turns: mergeThreadTurns(result.turns),
          closed: result.closed,
          awaitingPerson: result.awaitingPerson,
        });
        setFailed('');
      }
    })
    .catch((cause: unknown) => {
      // A failure to load history is not a reason to refuse to start a new
      // conversation, so the reason is stated and the thread stays usable.
      if (current) {
        setFailed(describe(cause));
      }
    });
  return () => {
    current = false;
  };
}

/**
 * Turns decided in this session, bucketed by order.
 *
 * Bucketed because a message about one order is not part of another's thread,
 * and because a request that is still in flight must land in the order it was
 * sent about - the customer can change their mind about which order they are
 * asking about while the model is thinking, and that reply still belongs to the
 * first one.
 *
 * The buckets outlive the selection, so switching away and back shows the same
 * thread rather than an empty one.
 */
function useLiveTurns(orderKey: string): {
  readonly turns: readonly Turn[];
  readonly begin: (order: string, text: string, id: string) => void;
  readonly settle: (order: string, id: string, turn: Turn) => void;
  readonly abandon: (order: string, id: string) => void;
} {
  const [buckets, setBuckets] = useState<TurnBuckets>({});

  const add = useCallback((order: string, next: (turns: readonly Turn[]) => readonly Turn[]) => {
    setBuckets((previous) => ({ ...previous, [order]: next(previous[order] ?? []) }));
  }, []);

  const begin = useCallback(
    (order: string, text: string, id: string) => {
      add(order, (turns) => [...turns, { kind: 'pending', id, text }]);
    },
    [add],
  );

  const settle = useCallback(
    (order: string, id: string, turn: Turn) => {
      add(order, (turns) => turns.map((existing) => (existing.id === id ? turn : existing)));
    },
    [add],
  );

  const abandon = useCallback(
    (order: string, id: string) => {
      add(order, (turns) => turns.filter((turn) => turn.id !== id));
    },
    [add],
  );

  return { turns: buckets[orderKey] ?? [], begin, settle, abandon };
}

/**
 * Conversation state for the selected order, separated from layout.
 *
 * The optimistic "pending" turn is the interesting part of sending: the customer
 * sees their message immediately and a "checking the policy…" placeholder, so the
 * slow part of the pipeline is visible rather than looking like a dropped
 * message. If the request fails the turn is withdrawn again.
 *
 * Stored and live turns are merged on the way out, de-duplicated by id. A turn
 * that has just been sent is also already in storage, so switching order and
 * back would otherwise show the same exchange twice - which reads as two
 * separate complaints about one problem.
 *
 * `blocked` exists because there are three distinct reasons not to send - no
 * signed-in customer, no order chosen, nothing typed - and they have different
 * fixes. Silently disabling the button for all three teaches a customer that the
 * page is broken. Each one is stated instead, with the thing to do about it.
 *
 * `itemIds` is the picker, not a second message. It rides along with the text and
 * narrows what the claim is about, so "the mug arrived broken" does not have to
 * be found in the words when the customer has already pointed at the line.
 */
export function useConversation(
  customerId: string | null,
  orderId: string | null,
  initialDraft = '',
): Conversation {
  const stored = useStoredThread(customerId, orderId);
  const live = useLiveTurns(orderId ?? '');
  // Seeded once, when the page mounts. The Orders page arrives with a reason
  // already chosen, and making the customer retype it is a small way of telling
  // them their click did not register.
  const [draft, setDraft] = useState<string>(initialDraft);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  // Transient, per request: set from the reply, cleared when the next one starts.
  const [notice, setNotice] = useState<string | null>(null);
  const awaitingPerson = stored.awaitingPerson;

  const blocked = blockedBecause(awaitingPerson, stored.closed, customerId, orderId);
  const turns = merge(stored.turns, live.turns);

  const send = useSendMessage({
    draft,
    busy,
    closed: stored.closed,
    customerId,
    orderId,
    turns,
    live,
    setDraft,
    setError,
    setNotice,
    setBusy,
  });

  return {
    turns,
    closed: stored.closed,
    notice,
    awaitingPerson,
    draft,
    busy,
    error: error.length > 0 ? error : stored.error,
    blocked,
    loading: stored.loading,
    setDraft,
    send,
    refresh: stored.reload,
  };
}

/** Sending a message: validate, scope, deliver, settle. Split out at the lint gate. */
function useSendMessage(args: {
  draft: string;
  busy: boolean;
  closed: boolean;
  customerId: string | null;
  orderId: string | null;
  turns: readonly Turn[];
  live: ReturnType<typeof useLiveTurns>;
  setDraft: (next: string) => void;
  setError: (next: string) => void;
  setNotice: (next: string | null) => void;
  setBusy: (next: boolean) => void;
}): (selectedIds?: readonly string[], override?: string) => Promise<void> {
  const { draft, busy, closed, customerId, orderId, turns, live } = args;
  const { setDraft, setError, setNotice, setBusy } = args;
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  return useCallback(
    async (selectedIds: readonly string[] = [], override?: string): Promise<void> => {
      const message = (override ?? draftRef.current).trim();
      if (!canSend(message, customerId, orderId, busy, closed)) {
        return;
      }
      // Narrowed for the calls below: the guard above already decided this, but
      // the decision does not travel through a function boundary.
      if (customerId === null) {
        return;
      }

      const resolved = resolveSendIds(selectedIds, turns);
      if (!resolved.ok) {
        setError(resolved.error);
        return;
      }
      const effectiveIds = resolved.itemIds;

      // Provisional id, replaced by the real request id once there is one, so the
      // turn can be found again and de-duplicated against stored history.
      const localId = `local-${Date.now()}`;
      const bucket = orderId ?? '';
      setDraft('');
      setError('');
      setNotice(null);
      setBusy(true);
      live.begin(bucket, message, localId);

      try {
        const reply = await api.sendMessage({ customerId, orderId, message, itemIds: effectiveIds });
        settleReply(bucket, localId, message, effectiveIds, reply, live);
      } catch (cause: unknown) {
        setError(describe(cause));
        live.abandon(bucket, localId);
      } finally {
        setBusy(false);
      }
    },
    [busy, closed, customerId, live, orderId, setBusy, setDraft, setError, setNotice, turns],
  );
}

/** The scope a send carries: explicit ticks win, otherwise the pending question's. */
function resolveSendIds(
  selectedIds: readonly string[],
  turns: readonly Turn[],
): { ok: true; itemIds: readonly string[] } | { ok: false; error: string } {
  const reportedError = reportedItemError(selectedIds, turns);
  if (reportedError !== undefined) {
    return { ok: false, error: reportedError };
  }
  // Answering carries the question's scope: the tap already does this by
  // sending its line, but a typed answer ("yes", "it") names nothing, and
  // leaving the scope for the server to infer makes it depend on which turn
  // the thread happens to sort last. The pending question's own scope is
  // exact, because it is the scope the question was asked under.
  return { ok: true, itemIds: selectedIds.length > 0 ? selectedIds : pendingAnswerScope(turns) };
}

/**
 * The duplicate-claim warning, when the customer ticked a decided line.
 *
 * A message scoped to a line with a decision would read as a second complaint
 * about the same problem, so the tick is refused with the reason stated. Lines
 * with only an open escalation stay tickable: nothing has been decided about
 * them, and the open-case and fork machinery routes the follow-up - refusing
 * it here would lock the customer out of their own open case.
 */
function reportedItemError(selectedIds: readonly string[], turns: readonly Turn[]): string | undefined {
  const previouslyReported = new Set(turns.flatMap(decidedItemIds));
  if (selectedIds.some((id) => previouslyReported.has(id))) {
    return 'You have already reported that item in this chat. Please choose a different item from this order, or tell me about a different problem. I’m here to help with anything else.';
  }
  return undefined;
}

/** Item ids this turn decided about: escalations decide nothing, so they block nothing. */
function decidedItemIds(turn: Turn): readonly string[] {
  if (turn.kind !== 'replied' && turn.kind !== 'stored') {
    return [];
  }
  if (turn.result.decision === 'escalated') {
    return [];
  }
  return turn.result.itemIds ?? [];
}

/** The scope of the question the thread is currently answering, if any. */
function pendingAnswerScope(turns: readonly Turn[]): readonly string[] {
  const last = turns.at(-1);
  if (last?.kind !== 'asked' && last?.kind !== 'storedAsk') {
    return [];
  }
  return last.itemIds ?? [];
}

/**
 * Whether a send may start. One predicate rather than five inline conditions,
 * because the composer disables on the same answer and the two must agree.
 */
function canSend(
  message: string,
  customerId: string | null,
  orderId: string | null,
  busy: boolean,
  closed: boolean,
): boolean {
  if (message.length === 0 || customerId === null || busy || closed) {
    return false;
  }
  return orderId !== null;
}

/**
 * Resolves a sent message into its live turn, by reply shape.
 *
 * A question is not a decision: the turn settles into its own shape and the
 * composer stays open, because the customer's next message is the answer to it,
 * and the server persists the exchange as dialogue so a refresh keeps it too.
 * A takeover routes the message to a person instead of the pipeline: the words
 * are stored on the takeover's thread and the agent is told, and the customer's
 * turn settles so they see their words like any other exchange - the agent's
 * reply arrives later over the socket. Only a decided request settles as a
 * replied turn.
 */
type SendReply = Awaited<ReturnType<typeof api.sendMessage>>;

function settleReply(
  orderId: string,
  localId: string,
  message: string,
  itemIds: readonly string[],
  reply: SendReply,
  live: { settle: (order: string, id: string, turn: Turn) => void },
): void {
  live.settle(orderId, localId, turnForReply(message, itemIds, reply));
}

/**
 * The live turn a reply settles into.
 *
 * One arm per reply shape, so the narrowing stays in one function: split
 * across helpers, the decision arm stops narrowing and the request fields go
 * `any`. Split out because the variant count outgrew the settler, and each
 * arm is one shape with no shared logic worth merging.
 */
function turnForReply(message: string, itemIds: readonly string[], reply: SendReply): Turn {
  if ('question' in reply) {
    return {
      kind: 'asked',
      id: reply.dialogueId,
      text: message,
      question: reply.question,
      picker: reply.picker ?? null,
      itemIds: reply.itemIds,
    };
  }
  if ('received' in reply) {
    return {
      kind: 'agent',
      id: reply.message.id,
      text: message,
      sender: 'customer',
      createdAt: reply.message.createdAt,
      media: reply.message.media ?? null,
      waitingForPerson: !reply.agentConnected,
    };
  }
  const { request, duplicate } = reply;
  return {
    kind: 'replied',
    id: request.id,
    text: message,
    result: {
      decision: request.decision.decision,
      refundAmountCents: request.decision.refundAmountCents,
      responseText: request.responseText,
      itemIds: itemIds.length > 0 ? itemIds : request.decision.eligibleItemIds,
      blockedItems: request.decision.blockedItems.map(({ name, reason }) => ({ name, reason })),
    },
    duplicate: duplicate ?? null,
  };
}

/**
 * A stored turn renders as `stored`, not as `replied`.
 *
 * The difference is not cosmetic. A `replied` turn was decided in this session
 * and carries the notice that a repeat was suppressed; a `stored` one is a
 * memory of an earlier decision rebuilt from the columns a customer is allowed
 * to see. Presenting the two identically would let a future caller reach for a
 * field the restored turn does not have and find a plausible-looking zero.
 */
function toTurn(stored: StoredTurn): Turn {
  if (stored.kind === 'update') {
    return { kind: 'update', id: stored.id, text: stored.body, ofRequestId: stored.requestId };
  }
  if (stored.kind === 'dialogue') {
    return {
      kind: 'storedAsk',
      id: stored.id,
      text: stored.message,
      question: stored.question,
      picker: stored.offer ?? null,
      itemIds: stored.itemIds,
    };
  }
  if (stored.kind === 'agent') {
    return {
      kind: 'agent',
      id: stored.id,
      text: stored.body,
      sender: stored.sender,
      createdAt: stored.createdAt,
      media: stored.media ?? null,
    };
  }
  if (stored.kind === 'handoff') {
    return { kind: 'handoff', id: stored.id, text: stored.body };
  }
  return {
    kind: 'stored',
    id: stored.requestId,
    text: stored.message,
    result: {
      decision: stored.decision,
      refundAmountCents: stored.refundAmountCents,
      responseText: stored.responseText,
      itemIds: stored.itemIds ?? [],
      blockedItems: stored.blockedItems ?? [],
    },
  };
}


/** Stored turns first, then live ones; a turn appearing in both is only drawn once. */
function merge(stored: readonly Turn[], live: readonly Turn[]): readonly Turn[] {
  const seen = new Set(stored.map((turn) => turn.id));
  return [...stored, ...live.filter((turn) => !seen.has(turn.id))];
}


