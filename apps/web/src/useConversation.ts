import { useCallback, useState } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import { api, describe } from './api';

/** One customer message and whatever came back for it. */
export type Turn =
  | { readonly kind: 'sent'; readonly id: string; readonly text: string }
  | { readonly kind: 'pending'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'replied';
      readonly id: string;
      readonly text: string;
      readonly result: RefundRequestDto;
    };

export interface Conversation {
  readonly turns: readonly Turn[];
  readonly draft: string;
  readonly busy: boolean;
  readonly error: string;
  readonly setDraft: (next: string) => void;
  readonly send: () => Promise<void>;
}

/**
 * Conversation state, separated from layout.
 *
 * The optimistic "pending" turn is the interesting part: the customer sees
 * their message immediately and a "checking the policy…" placeholder, so the
 * slow part of the pipeline is visible rather than looking like a dropped
 * message. If the request fails the turn is withdrawn again.
 */
export function useConversation(customerId: string, orderId: string | null): Conversation {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const send = useCallback(async (): Promise<void> => {
    const message = draft.trim();
    if (message.length === 0 || customerId.length === 0 || busy) {
      return;
    }

    const id = `local-${Date.now()}`;
    setDraft('');
    setError('');
    setBusy(true);
    setTurns((previous) => [...previous, { kind: 'pending', id, text: message }]);

    try {
      const { request } = await api.sendMessage({ customerId, orderId, message });
      setTurns((previous) => replaceTurn(previous, { kind: 'replied', id, text: message, result: request }));
    } catch (cause: unknown) {
      setError(describe(cause));
      setTurns((previous) => previous.filter((turn) => turn.id !== id));
    } finally {
      setBusy(false);
    }
  }, [busy, customerId, draft, orderId]);

  return { turns, draft, busy, error, setDraft, send };
}

function replaceTurn(turns: readonly Turn[], next: Turn): readonly Turn[] {
  return turns.map((turn) => (turn.id === next.id ? next : turn));
}
