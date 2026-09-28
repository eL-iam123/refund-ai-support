import { useState, type FormEvent, type ReactNode } from 'react';
import type { Decision, RefundRequestDto } from '@refund/shared';
import { api, describe } from '../api';
import { ErrorNote, Panel } from '../components';

const DECISIONS: readonly Decision[] = ['approved', 'denied', 'escalated'];

/**
 * The human in the loop, and the only write path in the whole UI.
 *
 * A note is mandatory. An override that cannot say why is indistinguishable
 * from an operator overriding the policy because they disagreed with it, and
 * that is exactly the behaviour a policy engine exists to make visible.
 *
 * The policy's own decision stays on screen afterwards - an override records a
 * second decision, it does not erase the first.
 */
export function OverrideForm({
  request,
  onApplied,
}: {
  request: RefundRequestDto;
  onApplied: () => void;
}): ReactNode {
  const [decision, setDecision] = useState<Decision>(request.decision.decision);
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (note.trim().length === 0) {
      setError('A human override has to say why.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.override(request.id, { decision, note: note.trim() });
      setNote('');
      onApplied();
    } catch (cause: unknown) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Human override">
      {request.overriddenBy === null ? null : <CurrentOverride request={request} />}
      <OverrideFields
        decision={decision}
        note={note}
        busy={busy}
        onDecision={setDecision}
        onNote={setNote}
        onSubmit={submit}
      />
      {error.length > 0 ? <ErrorNote error={error} /> : null}
    </Panel>
  );
}

function CurrentOverride({ request }: { request: RefundRequestDto }): ReactNode {
  return (
    <p className="note">
      Currently overridden by <strong>{request.overriddenBy}</strong>: {request.overrideNote}. The
      policy's own decision is still shown above and in the audit log.
    </p>
  );
}

interface Fields {
  readonly decision: Decision;
  readonly note: string;
  readonly busy: boolean;
  readonly onDecision: (next: Decision) => void;
  readonly onNote: (next: string) => void;
  readonly onSubmit: (event: FormEvent) => Promise<void>;
}

function OverrideFields({ decision, note, busy, onDecision, onNote, onSubmit }: Fields): ReactNode {
  return (
    <form
      className="override-form"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <label>
        Decision
        <select value={decision} onChange={(event) => onDecision(event.target.value as Decision)}>
          {DECISIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <p className="note">
        Recorded against the staff identity in your token, not anything typed here.
      </p>
      <label className="grow">
        Note
        <input
          value={note}
          onChange={(event) => onNote(event.target.value)}
          placeholder="why the policy is wrong here"
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Override'}
      </button>
    </form>
  );
}
