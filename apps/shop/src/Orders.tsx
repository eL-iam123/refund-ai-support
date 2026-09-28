import { useState, type ReactNode } from 'react';
import { describe, money, shopApi, type Decision, type ShopOrder } from './api';

/**
 * Checkout and order history.
 *
 * The important part of this page is `ReportProblem`: it posts to the real
 * `/api/chat/messages` endpoint, so a shopper testing the storefront is
 * exercising the same grounding, rule and money logic as the staff console, on
 * an order that genuinely exists.
 */
export function Orders({
  orders,
  user,
  onBought,
}: {
  orders: readonly ShopOrder[];
  user: string | null;
  onBought: () => void;
}): ReactNode {
  if (user === null) {
    return <p className="muted">Sign in to see your orders.</p>;
  }
  if (orders.length === 0) {
    return (
      <p className="muted">
        You have not bought anything yet. <button type="button" onClick={onBought}>Browse the shop</button>
      </p>
    );
  }

  return (
    <div className="orders">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} customerId={user} />
      ))}
    </div>
  );
}

function OrderCard({ order, customerId }: { order: ShopOrder; customerId: string }): ReactNode {
  return (
    <article className="card wide">
      <header className="row">
        <h3 className="mono">{order.id.slice(0, 22)}…</h3>
        <span className={`pill pill-${order.status}`}>{order.status}</span>
        <span className="num">{money(order.totalCents)}</span>
      </header>
      <p className="muted">
        placed {new Date(order.placedAt).toLocaleDateString()} · payment {order.paymentState} ·
        tracking {order.trackingStatus}
      </p>
      <ul className="lines">
        {order.items.map((item) => (
          <li key={item.name}>
            <span>
              {item.name} &times; {item.quantity}
            </span>
            <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
          </li>
        ))}
      </ul>
      <ReportProblem order={order} customerId={customerId} />
    </article>
  );
}

/**
 * The refund request form.
 *
 * `customerId` is sent because the endpoint requires it, and the server replaces
 * it with the signed-in customer when a session cookie is present. The warning
 * below is not decoration: without a session, that field is believed, which is
 * the one thing a tester should know before poking at the public chat endpoint.
 */
function ReportProblem({ order, customerId }: { order: ShopOrder; customerId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Report a problem with this order
      </button>
    );
  }

  return (
    <form
      className="report"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void shopApi
          .requestRefund({ customerId, orderId: order.id, message })
          .then((response) => setDecision(response.request.decision))
          .catch((cause: unknown) => setError(describe(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={`problem-${order.id}`}>What went wrong?</label>
      <textarea
        id={`problem-${order.id}`}
        rows={3}
        value={message}
        placeholder="The lamp arrived with a cracked shade."
        onChange={(event) => setMessage(event.target.value)}
      />
      <div className="row">
        <button type="submit" disabled={busy || message.trim().length === 0}>
          {busy ? 'Checking…' : 'Ask for a refund'}
        </button>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {decision !== null && <DecisionPanel decision={decision} />}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        Sent to the same decision engine the staff console uses, on this real order. A refusal names
        the rule that refused it.
      </p>
    </form>
  );
}

function DecisionPanel({ decision }: { decision: Decision }): ReactNode {
  return (
    <div className={`decision decision-${decision.decision}`}>
      <p className="row">
        <strong className={`pill pill-${decision.decision}`}>{decision.decision}</strong>
        <span className="mono small">{decision.policyRef}</span>
        <span className="num">{amountLine(decision)}</span>
      </p>
      <p className="small muted">{decision.summary}</p>
      {decision.decision === 'approved' ? (
        <p className="small muted">
          Approved, and held against your order so nothing else can be claimed on it. A member of
          the team checks it before the money is sent — nothing is paid out automatically, and you
          will see the payment on this order once they have.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one number a shopper actually cares about.
 *
 * An approval says what has been *agreed*, not what has been paid: the amount
 * waits on a human check before any money moves, and copy that said "refunded"
 * would be promising a payment the system has not made. Anything other than an
 * approval says plainly that nothing is payable and how much was at stake,
 * because "declined, $0.00" on its own reads like an error rather than a
 * decision.
 */
function amountLine(decision: Decision): string {
  if (decision.decision === 'approved') {
    return `${money(decision.refundAmountCents)} approved, awaiting payment`;
  }
  return `nothing payable · ${money(decision.eligibleAmountCents)} was at stake`;
}
