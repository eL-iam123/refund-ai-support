import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { describe, shopApi, type CustomerFork, type ForkThreadMessage } from './shop/api';

/**
 * The side panel: one escalated case's human thread at a time.
 *
 * A fork is what an escalation becomes once a person picks it up — the same
 * case, split off so it can be talked about without touching the customer's
 * other threads. The panel lists the customer's live forks newest first, each
 * with the case it was forked from in the header and a composer that files on
 * that fork's thread. Nothing here runs the pipeline: a message written in a
 * fork goes to the person on that case, and a message about anything else
 * belongs in the main composer, which stays open on every other thread.
 *
 * Renders nothing when signed out or forkless, so the page reads exactly as
 * before until the first escalation lands with a person.
 */
export function ForkPanel({
  forks,
  generation,
  refresh,
  socketError,
}: {
  forks: readonly CustomerFork[];
  generation: number;
  refresh: () => void;
  socketError: string | null;
}): ReactNode {
  if (forks.length === 0) {
    return null;
  }
  return (
    <aside className="fork-panel" aria-label="Your cases with a person">
      <h2>Talking with a person</h2>
      {socketError !== null && (
        <p className="error-note" role="status">{socketError}</p>
      )}
      {forks.map((fork) => (
        <ForkThread key={fork.handoffId} fork={fork} generation={generation} refresh={refresh} />
      ))}
    </aside>
  );
}

/** The customer's live forks, re-read whenever the shop socket says something changed. */
export function useForkList(customerId: string | null): {
  forks: readonly CustomerFork[];
  generation: number;
  refresh: () => void;
  socketError: string | null;
} {
  const [snapshot, setSnapshot] = useState<{ customer: string | null; forks: readonly CustomerFork[] }>({
    customer: null,
    forks: [],
  });
  const [generation, setGeneration] = useState(0);
  const [socketError, setSocketError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (customerId === null) {
      return;
    }
    const wanted = customerId;
    void shopApi
      .forks()
      .then(
        (result) => setSnapshot({ customer: wanted, forks: result.forks }),
        () =>
          setSnapshot((current) => (current.customer === wanted ? { customer: wanted, forks: [] } : current)),
      )
      .finally(() => setGeneration((current) => current + 1));
  }, [customerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (customerId === null) {
      return;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/shop/chat/ws`);
    socket.onmessage = () => refresh();
    socket.onerror = () => {
      setSocketError('The live update link dropped. Retrying in the background.');
    };
    return () => socket.close();
  }, [customerId, refresh]);

  return { forks: snapshot.customer === customerId ? snapshot.forks : [], generation, refresh, socketError };
}

/** One fork: what the case is about, the thread so far, and a box that writes to it. */
function ForkThread({ fork, generation, refresh }: { fork: CustomerFork; generation: number; refresh: () => void }): ReactNode {
  const { messages } = useForkMessages(fork.handoffId, generation);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  return (
    <section className="fork-thread" aria-label={forkTitle(fork)}>
      <p className="fork-case">{forkTitle(fork)}</p>
      {fork.unanswered && <p className="fork-waiting">A person has your case and will reply here.</p>}
      <div className="fork-log" ref={logRef}>
        {messages.map((message) => (
          <p key={message.id} className={message.sender === 'customer' ? 'bubble-me' : 'bubble-them'}>
            {message.body}
          </p>
        ))}
      </div>
      <ForkComposer handoffId={fork.handoffId} caseTitle={forkTitle(fork)} refresh={refresh} />
    </section>
  );
}

/** The box that files a follow-up on one fork's thread. */
function ForkComposer({
  handoffId,
  caseTitle,
  refresh,
}: {
  handoffId: string;
  caseTitle: string;
  refresh: () => void;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setError('');
    // Filed as a promise chain rather than awaited: the finally is the part
    // that matters, and an async callback with three setters reads worse.
    void postForkMessage(handoffId, body).then((failure) => {
      if (failure !== null) {
        setError(failure);
      } else {
        setDraft('');
        // The socket announces other people's messages, not your own: re-read
        // so the sent line appears without waiting for the agent's reply.
        refresh();
      }
      setBusy(false);
    });
  }, [draft, busy, handoffId, refresh]);

  return (
    <>
      {error.length > 0 && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="fork-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          id={`fork-input-${handoffId}`}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write to the person on this case…"
          aria-label={`Reply about ${caseTitle}`}
          disabled={busy}
        />
        <button type="submit" className="button-secondary small" disabled={busy || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </>
  );
}

/** Files a follow-up on a fork, returning the failure text or null on success. */
async function postForkMessage(handoffId: string, body: string): Promise<string | null> {
  try {
    await shopApi.sendForkMessage(handoffId, body);
    return null;
  } catch (cause: unknown) {
    return describe(cause);
  }
}

/** One fork's thread, re-read with the list so an agent reply lands without a refresh. */
function useForkMessages(handoffId: string, generation: number): { messages: readonly ForkThreadMessage[] } {
  const [messages, setMessages] = useState<readonly ForkThreadMessage[]>([]);
  useEffect(() => {
    let cancelled = false;
    void shopApi.forkMessages(handoffId).then(
      (result) => {
        if (!cancelled) {
          setMessages(result.messages);
        }
      },
      () => {
        if (!cancelled) {
          setMessages([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [handoffId, generation]);
  return { messages };
}

/** "Your case about the Blue mug and the Red lamp", or the order when the case named nothing. */
export function forkTitle(fork: CustomerFork): string {
  if (fork.items.length === 0) {
    return fork.orderId === null ? 'Your case with a person' : `Your case on order ${fork.orderId}`;
  }
  const names = fork.items.map((item) => `the ${item.name}`);
  return `Your case about ${new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names)}`;
}
