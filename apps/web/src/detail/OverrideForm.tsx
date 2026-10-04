import { useState, type FormEvent, type ReactNode } from 'react';
import type { Decision, RefundRequestDto } from '@refund/shared';
import { api, describe } from '../api';
import { ErrorNote, Panel } from '../components';

const DECISIONS: readonly Decision[] = [
  'approved',
  'partial_refund',
  'exchange',
  'store_credit',
  'denied',
  'escalated',
];

/**
 * Decisions that authorise money.
 *
 * Duplicated from the shared `MONEY_DECISIONS` rather than imported, because it is
 * used as a type and the shared set is a runtime value. The pair is checked against
 * each other by a test, so the two cannot drift into disagreeing about which
 * decisions move money - which is the one fact this form must not get wrong.
 */
const MONEY: ReadonlySet<Decision> = new Set<Decision>(['approved', 'partial_refund']);

function dollarsToCents(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

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
  const [amount, setAmount] = useState<string>('');
  const [acknowledge, setAcknowledge] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  // Turning a refusal into a payment is the one transition the server guards, and it
  // is guarded for a reason: the policy refused on evidence a person has to knowingly
  // overturn. The tick appears for exactly that transition, which is the same rule
  // `overrideGuard.ts` applies.
  const introducesMoney = MONEY.has(decision) && !MONEY.has(request.decision.decision);

  const draft = { decision, note, amount, acknowledge, introducesMoney };
  const clear = (): void => {
    setNote('');
    setAmount('');
    setAcknowledge(false);
  };
  const submit = (event: FormEvent): Promise<void> =>
    applyOverride({ event, requestId: request.id, ...draft, setBusy, setError, clear, onApplied });

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
      >
        {decision === 'partial_refund' ? (
          <AmountField
            amount={amount}
            eligibleCents={request.decision.eligibleAmountCents}
            onAmount={setAmount}
          />
        ) : null}
        {introducesMoney ? (
          <HardBlockAcknowledgement
            acknowledge={acknowledge}
            onAcknowledge={setAcknowledge}
          />
        ) : null}
      </OverrideFields>
      {error.length > 0 ? <ErrorNote error={error} /> : null}
    </Panel>
  );
}

/**
 * Closing the loop on a decision that moves no money.
 *
 * An exchange and a store credit authorise nothing, so nothing in the money path
 * knows the work still has to happen - and the customer was told a member of the
 * team would confirm the details here. Without this the outcome is terminal on
 * paper and open in reality.
 */
export function FulfilOutcome({
  request,
  onFulfilled,
}: {
  request: RefundRequestDto;
  onFulfilled: () => void;
}): ReactNode {
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [done, setDone] = useState<boolean>(false);

  if (request.decision.decision !== 'exchange' && request.decision.decision !== 'store_credit') {
    return null;
  }
  if (done) {
    return <RecordedPanel />;
  }

  const submit = (event: FormEvent): Promise<void> =>
    applyFulfilment({
      event,
      requestId: request.id,
      note,
      setBusy,
      setError,
      clear: () => setNote(''),
      onDone: () => {
        setDone(true);
        onFulfilled();
      },
    });

  return (
    <Panel title="Carry this out">
      <FulfilExplainer outcome={request.decision.decision} />
      <form
        className="override-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="grow">
          What was done
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={placeholderFor(request.decision.decision)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record it'}
        </button>
      </form>
      {error.length > 0 ? <ErrorNote error={error} /> : null}
    </Panel>
  );
}

function RecordedPanel(): ReactNode {
  return (
    <Panel title="Recorded as done">
      <p className="note">
        The customer has been told, and the audit chain records who did it and what they said.
      </p>
    </Panel>
  );
}

function placeholderFor(outcome: string): string {
  return outcome === 'exchange' ? 'replacement shipped on Tuesday' : 'credit added to the account';
}

function FulfilExplainer({ outcome }: { outcome: string }): ReactNode {
  return (
    <p className="muted">
      Nothing is reserved for a {outcome.replace(/_/g, ' ')}, so nothing tracks the work. Say here
      what was done and the customer is told in this thread - it is the promise the decision text
      made.
    </p>
  );
}

/**
 * The write, out of the component, for the same reason as the override above: both
 * refusals are about the request rather than about the form, and the customer is
 * told this note verbatim, so an empty one is refused before it is sent.
 */
async function applyFulfilment(input: {
  readonly event: FormEvent;
  readonly requestId: string;
  readonly note: string;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (message: string) => void;
  readonly clear: () => void;
  readonly onDone: () => void;
}): Promise<void> {
  input.event.preventDefault();
  if (input.note.trim().length === 0) {
    input.setError('Say what was done - the customer reads this.');
    return;
  }
  input.setBusy(true);
  input.setError('');
  try {
    await api.fulfilOutcome(input.requestId, input.note.trim());
    input.clear();
    input.onDone();
  } catch (cause: unknown) {
    input.setError(describe(cause));
  } finally {
    input.setBusy(false);
  }
}

/**
 * How much to authorise, for a partial refund.
 *
 * Only shown for that decision, because the server refuses an amount on every other
 * one - an approval re-derives the eligible figure and a non-money outcome carries
 * none, so a number anywhere else would be a second, conflicting source of truth.
 */
function AmountField({
  amount,
  eligibleCents,
  onAmount,
}: {
  amount: string;
  eligibleCents: number;
  onAmount: (next: string) => void;
}): ReactNode {
  return (
    <label className="grow">
      Amount to authorise
      <input
        value={amount}
        inputMode="decimal"
        onChange={(event) => onAmount(event.target.value)}
        placeholder={`up to $${(eligibleCents / 100).toFixed(2)} is eligible`}
      />
    </label>
  );
}

/**
 * The tick that makes overturning a refusal deliberate.
 *
 * It appears for the one transition the server guards - turning a non-payment into
 * a payment - and not otherwise, because asking an operator to acknowledge something
 * irrelevant is an obstacle dressed as a safeguard.
 */
function HardBlockAcknowledgement({
  acknowledge,
  onAcknowledge,
}: {
  acknowledge: boolean;
  onAcknowledge: (next: boolean) => void;
}): ReactNode {
  return (
    <label className="acknowledge">
      <input
        type="checkbox"
        checked={acknowledge}
        onChange={(event) => onAcknowledge(event.target.checked)}
      />
      The policy refused this, and I have read the rules it cited
    </label>
  );
}

/**
 * The write itself, out of the component.
 *
 * Two refusals happen here rather than in the JSX, because both are about the
 * request rather than about the form: a partial refund with no figure is
 * incomplete, and turning a refusal into a payment needs the acknowledgement the
 * server requires. Catching the first here means the operator is told which field
 * is missing instead of reading a validation error.
 */
async function applyOverride(input: {
  readonly event: FormEvent;
  readonly requestId: string;
  readonly decision: Decision;
  readonly note: string;
  readonly amount: string;
  readonly acknowledge: boolean;
  readonly introducesMoney: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (message: string) => void;
  readonly clear: () => void;
  readonly onApplied: () => void;
}): Promise<void> {
  input.event.preventDefault();
  if (input.note.trim().length === 0) {
    input.setError('A human override has to say why.');
    return;
  }
  const cents = input.decision === 'partial_refund' ? dollarsToCents(input.amount) : null;
  if (input.decision === 'partial_refund' && cents === null) {
    input.setError('A partial refund has to say how much to authorise.');
    return;
  }

  input.setBusy(true);
  input.setError('');
  try {
    await api.override(input.requestId, {
      decision: input.decision,
      note: input.note.trim(),
      ...(cents === null ? {} : { amountCents: cents }),
      ...(input.introducesMoney && input.acknowledge ? { acknowledgeHardBlock: true } : {}),
    });
    input.clear();
    input.onApplied();
  } catch (cause: unknown) {
    input.setError(describe(cause));
  } finally {
    input.setBusy(false);
  }
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
  /** The amount field and the acknowledgement, each rendered only when it applies. */
  readonly children: ReactNode;
  readonly onDecision: (next: Decision) => void;
  readonly onNote: (next: string) => void;
  readonly onSubmit: (event: FormEvent) => Promise<void>;
}

function OverrideFields({ decision, note, busy, children, onDecision, onNote, onSubmit }: Fields): ReactNode {
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
      {children}
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
