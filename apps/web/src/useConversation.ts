import { useCallback, useEffect, useState } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import { api, describe } from './api';
import { shopApi, type ChatTurn as StoredTurn } from './shop/api';

/**
 * What the server says about a suppressed repeat.
 *
 * Only set when the message matched one this customer had already sent. The
 * interface has to be here for the reason described on `Turn.replied`: an
 * endpoint that can return a request the caller did not just create is a sharp
 * edge, and this is the edge being declared rather than left to be discovered.
 */
export interface DuplicateNotice {
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
  /** True while an order's stored history is loading. */
  readonly loading: boolean;
  readonly setDraft: (next: string) => void;
  readonly send: (itemIds?: readonly string[]) => Promise<void>;
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
): { readonly turns: readonly Turn[]; readonly closed: boolean; readonly loading: boolean; readonly error: string; readonly reload: () => void } {
  const [loaded, setLoaded] = useState<LoadedThread | null>(null);
  const [failed, setFailed] = useState<string>('');
  // Bumped by `reload`. The socket announces "something changed, come look";
  // that announcement is not itself a turn, it is a reason to re-read storage -
  // the thread the customer and any agent see must come from the same query.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (orderId === null || customerId === null) {
      return;
    }
    let current = true;
    shopApi
      .chatHistory(orderId)
      .then((result) => {
        if (current && result.orderId === orderId) {
          setLoaded({ orderId, turns: result.turns.map(toTurn), closed: result.closed });
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
  }, [customerId, orderId, version]);

  const applies = loaded !== null && loaded.orderId === orderId;
  return {
    turns: applies ? loaded.turns : [],
    closed: applies && loaded.closed,
    loading: orderId !== null && customerId !== null && !applies && failed === '',
    error: failed,
    reload: () => setVersion((v) => v + 1),
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
function useLiveTurns(orderId: string | null): {
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

  return { turns: orderId === null ? [] : (buckets[orderId] ?? []), begin, settle, abandon };
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
  const live = useLiveTurns(orderId);
  // Seeded once, when the page mounts. The Orders page arrives with a reason
  // already chosen, and making the customer retype it is a small way of telling
  // them their click did not register.
  const [draft, setDraft] = useState<string>(initialDraft);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const blocked = stored.closed
    ? 'This conversation is closed after the final decision. You can no longer send messages on this order.'
    : reasonBlocked(customerId, orderId);
  const turns = merge(stored.turns, live.turns);

  const send = useCallback(async (selectedIds: readonly string[] = []): Promise<void> => {
    const message = draft.trim();
    if (message.length === 0 || customerId === null || orderId === null || busy || stored.closed) {
      return;
    }

    const previouslyReportedItemIds = [...new Set(
      turns.flatMap((turn) => (turn.kind === 'replied' || turn.kind === 'stored' ? turn.result.itemIds ?? [] : [])),
    )];

    if (selectedIds.some((id) => previouslyReportedItemIds.includes(id))) {
      setError('You have already reported that item in this chat. Please choose a different item from this order, or tell me about a different problem. I’m here to help with anything else.');
      return;
    }

    // Provisional id, replaced by the real request id once there is one, so the
    // turn can be found again and de-duplicated against stored history.
    const localId = `local-${Date.now()}`;
    setDraft('');
    setError('');
    setBusy(true);
    live.begin(orderId, message, localId);

    try {
      const reply = await api.sendMessage({ customerId, orderId, message, itemIds: selectedIds });
      settleReply(orderId, localId, message, selectedIds, reply, live);
    } catch (cause: unknown) {
      setError(describe(cause));
      live.abandon(orderId, localId);
    } finally {
      setBusy(false);
    }
  }, [busy, customerId, draft, live, orderId, stored.closed, turns]);

  return {
    turns,
    closed: stored.closed,
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
function settleReply(
  orderId: string,
  localId: string,
  message: string,
  itemIds: readonly string[],
  reply: Awaited<ReturnType<typeof api.sendMessage>>,
  live: { settle: (order: string, id: string, turn: Turn) => void },
): void {
  if ('question' in reply) {
    live.settle(orderId, localId, {
      kind: 'asked',
      id: reply.dialogueId,
      text: message,
      question: reply.question,
      itemIds: reply.itemIds,
    });
    return;
  }
  if ('received' in reply) {
    live.settle(orderId, localId, {
      kind: 'agent',
      id: reply.message.id,
      text: message,
      sender: 'customer',
      createdAt: reply.message.createdAt,
      media: reply.message.media ?? null,
    });
    return;
  }
  const { request, duplicate } = reply;
  live.settle(orderId, localId, {
    kind: 'replied',
    id: request.id,
    text: message,
    result: {
      decision: request.decision.decision,
      refundAmountCents: request.decision.refundAmountCents,
      responseText: request.responseText,
      itemIds: itemIds.length > 0 ? itemIds : request.decision.eligibleItemIds,
    },
    duplicate: duplicate ?? null,
  });
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
    return { kind: 'storedAsk', id: stored.id, text: stored.message, question: stored.question, itemIds: stored.itemIds };
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
    },
  };
}

/** Stored turns first, then live ones; a turn appearing in both is only drawn once. */
function merge(stored: readonly Turn[], live: readonly Turn[]): readonly Turn[] {
  const seen = new Set(stored.map((turn) => turn.id));
  return [...stored, ...live.filter((turn) => !seen.has(turn.id))];
}

function reasonBlocked(customerId: string | null, orderId: string | null): string | null {
  if (customerId === null) {
    return 'Sign in and the assistant can look up your orders.';
  }
  if (orderId === null) {
    return 'Choose the order you are asking about.';
  }
  return null;
}
