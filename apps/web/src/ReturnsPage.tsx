import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CARRIERS, type Carrier } from '@refund/shared';
import { api, describe, type ReturnDetailDto, type ReturnDto, type ReturnItemDto } from './api';
import { ErrorNote, Loading, Panel } from './components';

/**
 * The returns queue: the parcel, and every move it can legally make.
 *
 * This page exists because the whole return lifecycle was reachable by API and by
 * nothing else - five endpoints, five actions, and no way for a person to perform
 * any of them. A customer could ask for a return and then watch it sit, because the
 * staff console had no controls for it at all. A workflow the product can start but
 * not finish is not a workflow.
 *
 * What the page deliberately does not own is the rules. Which move is legal from
 * which state lives in `db/returns.ts`, and the server publishes the legal next
 * states alongside the record. A page keeping its own copy of that table drifts, and
 * the drift shows up as a button offering an illegal move - a parcel marked received
 * twice, or a denial after the goods were shelved.
 *
 * And it moves no money. Receiving and processing are facts about stock; what a
 * return means for the customer's money is decided by the policy engine on its own
 * request and still passes a human. That separation is the point of the return
 * routes, so this page does not blur it either.
 */

const STATUS_LABEL: Readonly<Record<ReturnDto['status'], string>> = {
  return_requested: 'asked for',
  return_label_generated: 'label issued',
  return_shipped: 'sent back',
  return_received: 'arrived',
  return_processed: 'processed',
  return_denied: 'declined',
};

/** Reuses the decision pills so a status reads like the outcome it sits closest to. */
const PILL_FOR_STATUS: Readonly<Record<ReturnDto['status'], string>> = {
  return_requested: 'escalated',
  return_label_generated: 'exchange',
  return_shipped: 'exchange',
  return_received: 'partial_refund',
  return_processed: 'approved',
  return_denied: 'denied',
};

/** The move each legal next state is reached by. One state, one action. */
const ACTION_FOR_STATE: Readonly<Record<string, Action>> = {
  return_label_generated: 'label',
  return_shipped: 'ship',
  return_received: 'receive',
  return_processed: 'process',
};

type Action = 'label' | 'ship' | 'receive' | 'process';

export function ReturnsPage(): ReactNode {
  const [returns, setReturns] = useState<readonly ReturnDto[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .listStaffReturns()
      .then((result) => {
        if (live) {
          setReturns(result.returns);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(describe(cause));
        }
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((current) => current + 1), []);

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Returns</h1>
        <p className="muted">
          The parcel, end to end. Nothing on this page pays anybody: a return is a fact about
          stock, and the money is decided by the policy on its own request.
        </p>
      </header>
      {error.length > 0 ? <ErrorNote error={error} /> : null}
      {returns === null ? (
        <Loading label="returns" />
      ) : (
        <ReturnTable returns={returns} onOpen={setOpen} />
      )}
      {/* Keyed by id so opening a different return remounts it. Clearing the previous
          record in an effect would render a frame of the wrong parcel's lines. */}
      {open === null ? null : <ReturnDetail key={open} id={open} onChanged={reload} />}
    </div>
  );
}

function ReturnTable({
  returns,
  onOpen,
}: {
  returns: readonly ReturnDto[];
  onOpen: (id: string) => void;
}): ReactNode {
  if (returns.length === 0) {
    return (
      <Panel title="Returns">
        <p className="empty">No returns yet.</p>
      </Panel>
    );
  }
  return (
    <Panel title={`${returns.length} return${returns.length === 1 ? '' : 's'}`}>
      <table className="table">
        <thead>
          <tr>
            <th>Return</th>
            <th>Status</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {returns.map((record) => (
            <tr key={record.id}>
              <td className="mono small">{record.id}</td>
              <td>
                <span className={`pill pill-${PILL_FOR_STATUS[record.status]}`}>
                  {STATUS_LABEL[record.status]}
                </span>
              </td>
              <td>{record.reason}</td>
              <td className="actions">
                <button type="button" onClick={(): void => onOpen(record.id)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * Running one of the moves, and saying so when it fails.
 *
 * The version counter is the part that matters: after a write the record is re-read,
 * so the next state shown is the server's judgement rather than this page's guess at
 * it. Without it, a parcel can read "arrived" twice.
 */
function useReturnActions(onChanged: () => void): {
  readonly busy: boolean;
  readonly error: string;
  readonly act: (action: () => Promise<unknown>) => Promise<void>;
  readonly version: number;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  const act = useCallback(
    async (run: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError('');
      try {
        await run();
        setVersion((current) => current + 1);
        onChanged();
      } catch (cause: unknown) {
        setError(describe(cause));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return { busy, error, act, version };
}

function ReturnDetail({ id, onChanged }: { id: string; onChanged: () => void }): ReactNode {
  const [detail, setDetail] = useState<ReturnDetailDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const { busy, act, version } = useReturnActions(onChanged);

  useEffect(() => {
    let live = true;
    void api
      .staffReturn(id)
      .then((result) => {
        if (live) {
          setDetail(result);
          setLoadError('');
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setLoadError(describe(cause));
        }
      });
    return () => {
      live = false;
    };
  }, [id, version]);

  return <ReturnDetailBody detail={detail} error={loadError} busy={busy} act={act} />;
}

function ReturnDetailBody({
  detail,
  error,
  busy,
  act,
}: {
  detail: ReturnDetailDto | null;
  error: string;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}): ReactNode {
  if (detail === null) {
    return (
      <Panel title="Return">
        <Loading label="return" />
      </Panel>
    );
  }
  const closed = detail.nextStates.length === 0 && !detail.canDeny;
  return (
    <Panel title={`Return ${detail.return.id}`}>
      {error.length > 0 ? <ErrorNote error={error} /> : null}
      <ReturnFacts detail={detail} />
      <div className="row">
        {detail.nextStates.map((state) => (
          <ReturnAction
            key={state}
            action={ACTION_FOR_STATE[state] ?? 'process'}
            record={detail.return}
            items={detail.items}
            busy={busy}
            onAct={act}
          />
        ))}
        {detail.canDeny ? <DenyAction id={detail.return.id} busy={busy} onAct={act} /> : null}
      </div>
      {closed ? <ClosedNote /> : null}
    </Panel>
  );
}

function ReturnFacts({ detail }: { detail: ReturnDetailDto }): ReactNode {
  const record = detail.return;
  return (
    <dl className="kv">
      <dt>Status</dt>
      <dd>{STATUS_LABEL[record.status]}</dd>
      <dt>Order</dt>
      <dd className="mono small">{record.orderId}</dd>
      <dt>Reason</dt>
      <dd>{record.reason}</dd>
      {record.carrier === null ? null : (
        <>
          <dt>Carrier</dt>
          <dd>{record.carrier}</dd>
        </>
      )}
      {record.trackingNumber === null ? null : (
        <>
          <dt>Tracking</dt>
          <dd className="mono small">{record.trackingNumber}</dd>
        </>
      )}
      {record.labelUrl === null ? null : (
        <>
          <dt>Label</dt>
          <dd>
            <a href={record.labelUrl} target="_blank" rel="noreferrer">
              open the customer&apos;s label
            </a>
          </dd>
        </>
      )}
      {record.deniedReason === null ? null : (
        <>
          <dt>Declined because</dt>
          <dd>{record.deniedReason}</dd>
        </>
      )}
      <dt>Lines</dt>
      <dd>
        <ul className="plain">
          {detail.items.map((item) => (
            <li key={item.id}>{lineLabel(item)}</li>
          ))}
        </ul>
      </dd>
    </dl>
  );
}

function lineLabel(item: ReturnItemDto): string {
  const condition = item.condition === null ? '' : ` - ${item.condition}`;
  const restocked = item.restockedQuantity > 0 ? ` (${item.restockedQuantity} restocked)` : '';
  return `${item.quantity} x ${item.name}${condition}${restocked}`;
}

function ClosedNote(): ReactNode {
  return (
    <p className="muted small">
      Closed. Nothing further can be done to this return - the goods were dealt with, and reopening
      it would mean reconciling two histories.
    </p>
  );
}

interface ActionProps {
  readonly action: Action;
  readonly record: ReturnDto;
  readonly items: readonly ReturnItemDto[];
  readonly busy: boolean;
  readonly onAct: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * One card per action, each owning only the fields it needs.
 *
 * Split because the four share nothing but a button: a label needs a carrier and a
 * URL, a shipment needs a tracking number, a receipt needs a condition per line, and
 * restocking needs a quantity per line. Together they were one function with four
 * unrelated pieces of state and four branches to reason about at once.
 */
function ReturnAction(props: ActionProps): ReactNode {
  const { action } = props;
  if (action === 'label') {
    return <LabelAction {...props} />;
  }
  if (action === 'ship') {
    return <ShipAction {...props} />;
  }
  if (action === 'receive') {
    return <ReceiveAction {...props} />;
  }
  return <ProcessAction {...props} />;
}

function CarrierPicker({
  carrier,
  onCarrier,
}: {
  carrier: Carrier;
  onCarrier: (next: Carrier) => void;
}): ReactNode {
  return (
    <select
      value={carrier}
      aria-label="carrier"
      onChange={(event): void => onCarrier(event.target.value as Carrier)}
    >
      {CARRIERS.map((option) => (
        <option key={option} value={option}>
          {option.toUpperCase()}
        </option>
      ))}
    </select>
  );
}

function LabelAction({ record, busy, onAct }: ActionProps): ReactNode {
  const [carrier, setCarrier] = useState<Carrier>('usps');
  const [labelUrl, setLabelUrl] = useState('');
  return (
    <ActionCard
      title="Issue a return label"
      help="Bought from the carrier and pasted here. A URL that looks right and 404s is worse than a visible failure - the customer finds out after the box is packed."
    >
      <CarrierPicker carrier={carrier} onCarrier={setCarrier} />
      <input
        value={labelUrl}
        aria-label="label url"
        placeholder="https://carrier.example/label/abc"
        onChange={(event): void => setLabelUrl(event.target.value)}
      />
      <button
        type="button"
        disabled={busy || !isWebUrl(labelUrl)}
        onClick={(): void =>
          void onAct(() => api.labelReturn(record.id, { carrier, labelUrl: labelUrl.trim() }))
        }
      >
        {busy ? 'Working…' : 'Issue label'}
      </button>
    </ActionCard>
  );
}

function ShipAction({ record, busy, onAct }: ActionProps): ReactNode {
  const [carrier, setCarrier] = useState<Carrier>('usps');
  const [tracking, setTracking] = useState('');
  return (
    <ActionCard title="Mark as sent back" help="Only once the parcel is actually with the carrier.">
      <CarrierPicker carrier={carrier} onCarrier={setCarrier} />
      <input
        value={tracking}
        aria-label="tracking number"
        placeholder="tracking number"
        onChange={(event): void => setTracking(event.target.value)}
      />
      <button
        type="button"
        disabled={busy || tracking.trim().length < 4}
        onClick={(): void =>
          void onAct(() => api.shipReturn(record.id, { carrier, trackingNumber: tracking.trim() }))
        }
      >
        {busy ? 'Working…' : 'Mark shipped'}
      </button>
    </ActionCard>
  );
}

function ReceiveAction({ record, items, busy, onAct }: ActionProps): ReactNode {
  const [condition, setCondition] = useState('as described');
  return (
    <ActionCard
      title="Receive the goods"
      help="What arrived, and in what condition. A fact about stock - it pays nobody."
    >
      {items.map((item) => (
        <div key={item.id} className="row">
          <span className="grow">{lineLabel(item)}</span>
          <input
            value={condition}
            aria-label={`condition for ${item.name}`}
            onChange={(event): void => setCondition(event.target.value)}
          />
        </div>
      ))}
      <button
        type="button"
        disabled={busy || items.length === 0}
        onClick={(): void =>
          void onAct(() =>
            api.receiveReturn(record.id, {
              lines: items.map((item) => ({
                itemId: item.itemId,
                quantity: item.quantity,
                condition: condition.trim(),
              })),
            }),
          )
        }
      >
        {busy ? 'Working…' : 'Mark received'}
      </button>
    </ActionCard>
  );
}

function ProcessAction({ record, items, busy, onAct }: ActionProps): ReactNode {
  const [restock, setRestock] = useState<Readonly<Record<string, number>>>({});
  return (
    <ActionCard
      title="Process and restock"
      help="Puts the saleable goods back on the shelf. Nothing here pays anybody."
    >
      {items.map((item) => (
        <div key={item.id} className="row">
          <span className="grow">{item.name}</span>
          <input
            type="number"
            min={0}
            max={item.quantity}
            aria-label={`restock ${item.name}`}
            value={String(restock[item.itemId] ?? item.quantity)}
            onChange={(event): void =>
              setRestock({ ...restock, [item.itemId]: Number(event.target.value) })
            }
          />
        </div>
      ))}
      <button
        type="button"
        disabled={busy || items.length === 0}
        onClick={(): void =>
          void onAct(() =>
            api.processReturn(record.id, {
              restock: items.map((item) => ({
                itemId: item.itemId,
                quantity: restock[item.itemId] ?? item.quantity,
              })),
            }),
          )
        }
      >
        {busy ? 'Working…' : 'Process'}
      </button>
    </ActionCard>
  );
}

function DenyAction({
  id,
  busy,
  onAct,
}: {
  id: string;
  busy: boolean;
  onAct: (action: () => Promise<unknown>) => Promise<void>;
}): ReactNode {
  const [reason, setReason] = useState('');
  return (
    <ActionCard
      title="Decline this return"
      help="With a reason the customer could be shown. Any return that is not closed can be declined."
    >
      <input
        value={reason}
        aria-label="decline reason"
        placeholder="why - the customer reads this"
        onChange={(event): void => setReason(event.target.value)}
      />
      <button
        type="button"
        disabled={busy || reason.trim().length === 0}
        onClick={(): void => void onAct(() => api.denyReturn(id, reason.trim()))}
      >
        {busy ? 'Working…' : 'Decline'}
      </button>
    </ActionCard>
  );
}

function ActionCard({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="muted small">{help}</p>
      {children}
    </div>
  );
}

function isWebUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}