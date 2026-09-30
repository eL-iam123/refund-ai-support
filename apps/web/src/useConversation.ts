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
    };

export interface Conversation {
  readonly turns: readonly Turn[];
  readonly draft: string;
  readonly busy: boolean;
  readonly error: string;
  /** Why the composer will not send, or null when it will. */
  readonly blocked: string | null;
  /** True while an order's stored history is loading. */
  readonly loading: boolean;
  readonly setDraft: (next: string) => void;
  readonly send: () => Promise<void>;
}

/** Turns held in this session, per order. See `useLiveTurns`. */
type TurnBuckets = Readonly<Record<string, readonly Turn[]>>;

/** The history loaded so far, tagged with the order it belongs to. */
interface LoadedThread {
  readonly orderId: string;
  readonly turns: readonly Turn[];
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
): { readonly turns: readonly Turn[]; readonly loading: boolean; readonly error: string } {
  const [loaded, setLoaded] = useState<LoadedThread | null>(null);
  const [failed, setFailed] = useState<string>('');

  useEffect(() => {
    if (orderId === null || customerId === null) {
      return;
    }
    let current = true;
    shopApi
      .chatHistory(orderId)
      .then((result) => {
        if (current && result.orderId === orderId) {
          setLoaded({ orderId, turns: result.turns.map(toTurn) });
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
  }, [customerId, orderId]);

  const applies = loaded !== null && loaded.orderId === orderId;
  return {
    turns: applies ? loaded.turns : [],
    loading: orderId !== null && customerId !== null && !applies && failed === '',
    error: failed,
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

  const blocked = reasonBlocked(customerId, orderId);
  const turns = merge(stored.turns, live.turns);

  const send = useCallback(async (): Promise<void> => {
    const message = draft.trim();
    if (message.length === 0 || customerId === null || orderId === null || busy) {
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
      const reply = await api.sendMessage({ customerId, orderId, message });
      if ('question' in reply) {
        // A question is not a decision: the turn settles into its own shape and
        // the composer stays open, because the customer's next message is the
        // answer to it - and the server persists the exchange as dialogue, so
        // a refresh keeps it too.
        live.settle(orderId, localId, {
          kind: 'asked',
          id: reply.dialogueId,
          text: message,
          question: reply.question,
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
        },
        duplicate: duplicate ?? null,
      });
    } catch (cause: unknown) {
      setError(describe(cause));
      live.abandon(orderId, localId);
    } finally {
      setBusy(false);
    }
  }, [busy, customerId, draft, live, orderId]);

  return { turns, draft, busy, error: error.length > 0 ? error : stored.error, blocked, loading: stored.loading, setDraft, send };
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
    return { kind: 'storedAsk', id: stored.id, text: stored.message, question: stored.question };
  }
  return {
    kind: 'stored',
    id: stored.requestId,
    text: stored.message,
    result: {
      decision: stored.decision,
      refundAmountCents: stored.refundAmountCents,
      responseText: stored.responseText,
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
