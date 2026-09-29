import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { money, type ShopOrder } from './api';
import { REASONS, reasonFor } from './issueReasons';
import type { CartLine } from './cartStore';

/**
 * Order history, and the two things a shopper wants from it.
 *
 * Both actions exist because the storefront is the only way to get a real order
 * to test a refund against. "Buy again" refills the cart with the same lines,
 * and "report an issue" carries the order into the assistant.
 *
 * The handoff is a query string rather than router state. That is a small thing
 * with a real consequence: router state dies on a refresh, so a shopper who
 * picked a reason, landed in the assistant, realised they meant to add the
 * delivery date, and pressed reload would arrive at a blank composer with no
 * explanation. A URL survives that, and can be pasted to a colleague.
 */
export function Orders({
  orders,
  signedIn,
  onRefill,
  onBrowse,
}: {
  orders: readonly ShopOrder[];
  signedIn: boolean;
  onRefill: (lines: readonly CartLine[]) => void;
  onBrowse: () => void;
}): ReactNode {
  if (!signedIn) {
    return (
      <section className="card">
        <h1>Your orders</h1>
        <p className="muted">Sign in to see what you have bought.</p>
        <button type="button" onClick={onBrowse}>
          Back to the shop
        </button>
      </section>
    );
  }
  if (orders.length === 0) {
    return (
      <section className="card">
        <h1>Your orders</h1>
        <p className="muted">Nothing yet.</p>
        <button type="button" onClick={onBrowse}>
          Start shopping
        </button>
      </section>
    );
  }
  return (
    <div className="stack">
      <h1>Your orders</h1>
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} onRefill={onRefill} />
      ))}
    </div>
  );
}

/** When it was bought and where it got to. Facts, not status vocabulary. */
function OrderMeta({ order }: { order: ShopOrder }): ReactNode {
  return (
    <p className="muted small">
      Placed {new Date(order.placedAt).toLocaleDateString()} · payment {order.paymentState} ·
      delivery {order.trackingStatus}
    </p>
  );
}

function OrderCard({
  order,
  onRefill,
}: {
  order: ShopOrder;
  onRefill: (lines: readonly CartLine[]) => void;
}): ReactNode {
  const navigate = useNavigate();
  const [reporting, setReporting] = useState(false);

  /**
   * Only lines that still map to a catalogue product are refilled. A product
   * that has since been delisted keeps its history but cannot be re-bought, and
   * saying so is better than silently re-ordering something else.
   *
   * The filter is what narrows the type too, so the `as string` below is
   * narrowing a type the compiler has already been told is safe rather than
   * asserting past a null it has not checked.
   */
  const buyable = order.items.filter((item) => item.productId !== null);
  const gone = order.items.length - buyable.length;

  const refill = (): void =>
    onRefill(
      buyable.map((item) => ({
        productId: item.productId === null ? '' : item.productId,
        quantity: item.quantity,
      })),
    );

  return (
    <article className="card">
      <header className="row">
        <span className={`pill pill-${order.status}`}>{order.status.replace(/_/g, ' ')}</span>
        <strong className="num">{money(order.totalCents)}</strong>
      </header>
      <p className="mono small">{order.id}</p>
      <OrderMeta order={order} />

      <ul className="lines">
        {order.items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <span>
              {item.name} <span className="muted">x{item.quantity}</span>
            </span>
            <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
          </li>
        ))}
      </ul>

      <div className="row">
        <button type="button" className="btn-secondary" disabled={buyable.length === 0} onClick={refill}>
          <RefreshCw size={16} /> Buy again
        </button>
        <button type="button" className="btn-primary" onClick={() => setReporting(true)}>
          <AlertCircle size={16} /> Report an issue
        </button>
      </div>
      {gone > 0 ? <p className="muted small">{gone} item(s) no longer in the catalogue.</p> : null}

      {reporting ? (
        <IssuePicker
          order={order}
          onCancel={() => setReporting(false)}
          onSubmit={(issueId) => {
            setReporting(false);
            void navigate(`/help?order=${encodeURIComponent(order.id)}&issue=${encodeURIComponent(issueId)}`);
          }}
        />
      ) : null}
    </article>
  );
}

/**
 * Picking a reason is enough to continue.
 *
 * The button used to stay greyed out until a message was typed as well, which
 * read as a broken picker: you choose "arrived damaged", the button does
 * nothing, and there is no hint that the real requirement was a free-text box
 * underneath it. So the choice is the whole form, and the wording it produces
 * is a draft on the next screen that the shopper can still edit.
 */
function IssuePicker({
  order,
  onCancel,
  onSubmit,
}: {
  order: ShopOrder;
  onCancel: () => void;
  onSubmit: (issueId: string) => void;
}): ReactNode {
  const [selected, setSelected] = useState<string>('');

  return (
    <form
      className="issue-picker"
      onSubmit={(event) => {
        event.preventDefault();
        // Guarded rather than trusted: `selected` is client state, and a form
        // submit with nothing chosen would otherwise navigate to `issue=`.
        if (reasonFor(selected) !== undefined) {
          onSubmit(selected);
        }
      }}
    >
      <h2 className="label">What is wrong with {order.id}?</h2>
      <div className="issue-list">
        {REASONS.map((issue) => (
          <label key={issue.id} className="issue-option">
            <input
              type="radio"
              name={`issue-${order.id}`}
              value={issue.id}
              checked={selected === issue.id}
              onChange={() => setSelected(issue.id)}
            />
            <span>{issue.label}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <button type="submit" className="btn-primary" disabled={selected.length === 0}>
          Continue
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
