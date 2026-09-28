import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RefundDto } from '@refund/shared';
import { api, describe } from './api';
import { ErrorNote, Loading, Panel } from './components';
import { useAsyncData } from './useAsyncData';
import { formatCents } from './format';

/**
 * The verification queue.
 *
 * Every approved refund lands here first, because an approval is a decision and
 * not a payment. This screen is the gap between the two, and it exists so that
 * gap is a deliberate human step rather than an assumption in a payout job.
 *
 * Two buttons, deliberately not one. "Settle" issues money and is recorded
 * against the reviewer; "Release" gives the reservation back and is why a
 * customer can still claim the rest of an order. Collapsing them into one cancel
 * would make the unreviewed path as easy to take as the reviewed one.
 */
export function RefundsPage(): ReactNode {
  const load = useCallback(async () => (await api.pendingRefunds()).refunds, []);
  const state = useAsyncData(load, 'refunds');

  if (state.status === 'error') {
    return <ErrorNote error={state.error} />;
  }
  if (state.status === 'loading') {
    return <Loading label="Loading the queue…" />;
  }
  return <Queue refunds={state.value} />;
}

function Queue({ refunds }: { refunds: RefundDto[] }): ReactNode {
  if (refunds.length === 0) {
    return (
      <Panel title="Awaiting verification">
        <p className="note">
          Nothing is waiting. An approved refund appears here until someone confirms it, and the
          money does not move until then.
        </p>
      </Panel>
    );
  }

  const total = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
  return (
    <Panel
      title="Awaiting verification"
      action={<span className="muted">{refunds.length} pending · {formatCents(total)}</span>}
    >
      <p className="note">
        These amounts have been approved by policy and are being held against their orders. They
        have <strong>not</strong> been paid: nothing is charged or transferred until a reviewer
        settles a row below. Each one is linked to the request that authorised it.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Amount</th>
            <th>Order</th>
            <th>Approved</th>
            <th>Idempotency key</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {refunds.map((refund) => (
            <Row key={refund.id} refund={refund} />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

type Action = 'settle' | 'release';

interface RowState {
  readonly reason: string;
  readonly busy: Action | null;
  readonly error: string;
  readonly done: string;
}

const INITIAL: RowState = { reason: '', busy: null, error: '', done: '' };

function useRowAction(refund: RefundDto): {
  state: RowState;
  setReason: (next: string) => void;
  act: (action: Action) => Promise<void>;
} {
  const [state, setState] = useState<RowState>(INITIAL);
  const { amountCents, id } = refund;

  const act = async (action: Action): Promise<void> => {
    if (action === 'release' && state.reason.trim().length === 0) {
      setState({ ...state, error: 'Say why the reservation is being given back.' });
      return;
    }
    setState({ ...state, busy: action, error: '' });
    try {
      if (action === 'settle') {
        await api.settleRefund(id);
        setState({ ...state, busy: null, error: '', done: `Settled ${formatCents(amountCents)}.` });
      } else {
        await api.releaseRefund(id, state.reason.trim());
        setState({ ...state, busy: null, error: '', done: 'Reservation released. The order is claimable again.' });
      }
    } catch (cause: unknown) {
      setState({ ...state, busy: null, error: describe(cause), done: '' });
    }
  };

  return { state, setReason: (next: string) => setState({ ...state, reason: next }), act };
}

function Row({ refund }: { refund: RefundDto }): ReactNode {
  const { state, setReason, act } = useRowAction(refund);

  return (
    <tr>
      <td>
        <strong>{formatCents(refund.amountCents)}</strong>
        <br />
        <small className="muted">{refund.status}</small>
      </td>
      <td>
        <Link to={`/admin/requests/${refund.requestId}`}>{refund.orderId}</Link>
        <br />
        <small className="muted">{refund.customerId}</small>
      </td>
      <td>
        <small className="muted">{new Date(refund.createdAt).toLocaleString()}</small>
      </td>
      <td>
        {/* Shown because this is the value a payment processor will be given.
            A reviewer should be able to see it is stable, not guess. */}
        <small className="muted mono">{refund.idempotencyKey.slice(0, 16)}…</small>
      </td>
      <td className="actions">
        {state.done.length > 0 ? (
          <span className="muted">{state.done}</span>
        ) : (
          <>
            <input
              value={state.reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="reason, if releasing"
              aria-label={`reason for releasing ${formatCents(refund.amountCents)}`}
            />
            <button type="button" disabled={state.busy !== null} onClick={() => void act('settle')}>
              {state.busy === 'settle' ? 'Settling…' : 'Settle — pay it'}
            </button>
            <button type="button" disabled={state.busy !== null} onClick={() => void act('release')}>
              {state.busy === 'release' ? 'Releasing…' : 'Release'}
            </button>
          </>
        )}
        {state.error.length > 0 ? <ErrorNote error={state.error} /> : null}
      </td>
    </tr>
  );
}
