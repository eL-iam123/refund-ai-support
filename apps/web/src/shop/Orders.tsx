import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
export function OrderDetails({ order, onBack, onReport }: { order: ShopOrder; onBack: () => void; onReport: () => void }): ReactNode {
  return (
    <div className="order-detail-page">
      <button type="button" className="btn-quiet order-back" onClick={onBack}>← Back to orders</button>
      <header className="order-detail-heading"><div><p className="eyebrow">Order details</p><h1>{order.id}</h1><p className="lede">Placed {new Date(order.placedAt).toLocaleDateString()}</p></div><span className={`pill pill-${order.status}`}>{order.status.replace(/_/g, ' ')}</span></header>
      <section className="order-detail-grid">
        <div className="order-detail-card card"><p className="eyebrow">Delivery</p><h2>{order.trackingStatus.replace(/_/g, ' ')}</h2><p className="muted">Payment {order.paymentState}</p></div>
        <div className="order-detail-card card"><p className="eyebrow">Total paid</p><h2 className="num">{money(order.totalCents)}</h2><p className="muted">All taxes and delivery included</p></div>
      </section>
      <section className="order-detail-card card"><div className="section-heading"><div><p className="eyebrow">Items</p><h2>What&apos;s in this order</h2></div><button type="button" className="btn-primary" onClick={onReport}>Get help</button></div><OrderLines items={order.items} /></section>
    </div>
  );
}

export function Orders({
  orders,
  signedIn,
  counts,
  onRefill,
  onBrowse,
}: {
  orders: readonly ShopOrder[];
  signedIn: boolean;
  counts: readonly { orderId: string; count: number }[];
  onRefill: (lines: readonly CartLine[]) => void;
  onBrowse: () => void;
}): ReactNode {
  const countMap = useMemo(() => new Map(counts.map((row) => [row.orderId, row.count])), [counts]);
  const notice = useNewReplyNotice(counts);

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
    <div className="orders-page">
      <header className="orders-heading">
        <div>
          <p className="eyebrow">Account / Purchases</p>
          <h1>Your orders</h1>
          <p className="lede">Track deliveries, revisit purchases, or get help with an order.</p>
        </div>
        <div className="orders-summary"><strong>{orders.length}</strong><span>orders</span></div>
      </header>
      {notice ? (
        <div className="response-toast" role="status" aria-live="polite">
          New reply for {notice.orderId}. Open the chat to see the latest update.
        </div>
      ) : null}
      <div className="orders-toolbar">
        <span className="muted small">Recent activity</span>
        <span className="orders-toolbar-line" aria-hidden="true" />
        <span className="muted small">Showing all orders</span>
      </div>
      <div className="orders-grid">
        {orders.map((order) => (
          <OrderCard key={order.id} order={order} messageCount={countMap.get(order.id) ?? 0} onRefill={onRefill} />
        ))}
      </div>
    </div>
  );
}

const NOTICE_MS = 7000;

/**
 * Which order gained replies since the last time these counts arrived.
 *
 * "Since the last time" is the whole difficulty, and it is why this is a hook
 * rather than a derived value: the comparison needs a snapshot of the previous
 * counts, and the snapshot belongs next to the data rather than in the server.
 * The snapshot is a ref because it is bookkeeping, not something to render - a
 * ref write is invisible, which is exactly right for a value the shopper never
 * sees.
 *
 * The notice state is set from a timer rather than directly in the effect body.
 * Setting it inline would force a second render in the same tick as the data
 * arriving - a cascade React has good reason to warn about - and the toast is an
 * announcement, so a tick of delay changes nothing anyone can perceive. Both
 * timers are cleared on cleanup, so a count that changes again before the toast
 * is up replaces it rather than stacking.
 */
function useNewReplyNotice(
  counts: readonly { orderId: string; count: number }[],
): { orderId: string; count: number } | null {
  const [notice, setNotice] = useState<{ orderId: string; count: number } | null>(null);
  const previousCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const next = firstCountIncrease(counts, previousCounts.current);
    previousCounts.current = new Map(counts.map((row) => [row.orderId, row.count]));

    if (next === null) {
      return;
    }

    const show = window.setTimeout(() => setNotice(next), 0);
    const dismiss = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(dismiss);
    };
  }, [counts]);

  return notice;
}

/** The first order whose count rose above a count this customer already had. */
function firstCountIncrease(
  counts: readonly { orderId: string; count: number }[],
  previous: ReadonlyMap<string, number>,
): { orderId: string; count: number } | null {
  for (const row of counts) {
    const before = previous.get(row.orderId) ?? 0;
    if (row.count > before && before > 0) {
      return { orderId: row.orderId, count: row.count };
    }
  }
  return null;
}

function OrderCard({
  order,
  messageCount,
  onRefill,
}: {
  order: ShopOrder;
  messageCount: number;
  onRefill: (lines: readonly CartLine[]) => void;
}): ReactNode {
  const navigate = useNavigate();
  const [reporting, setReporting] = useState(false);

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
    <article className="order-card card" role="link" tabIndex={0} onClick={(event) => { if ((event.target as HTMLElement).closest('button')) return; void navigate(`/orders/${encodeURIComponent(order.id)}`); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void navigate(`/orders/${encodeURIComponent(order.id)}`); } }}>
      <header className="order-card-top">
        <div className="order-card-head">
          <span className={`pill pill-${order.status}`}>{order.status.replace(/_/g, ' ')}</span>
          {messageCount > 0 ? <span className="order-message-badge">{messageCount === 1 ? '1 new reply' : `${messageCount} messages`}</span> : null}
        </div>
        <span className="order-total"><strong className="num">{money(order.totalCents)}</strong><span>Total paid</span></span>
      </header>
      <div className="order-card-id"><span>Order placed {new Date(order.placedAt).toLocaleDateString()}</span><span className="mono">{order.id}</span></div>
      <div className="order-delivery"><span className="delivery-dot" aria-hidden="true" /><div><strong>{order.trackingStatus.replace(/_/g, ' ')}</strong><span>Payment {order.paymentState}</span></div></div>
      <OrderLines items={order.items} />

      <OrderActions
        gone={gone}
        buyableCount={buyable.length}
        messageCount={messageCount}
        onRefill={refill}
        onReport={() => setReporting(true)}
      />

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

function OrderActions({
  gone,
  buyableCount,
  messageCount,
  onRefill,
  onReport,
}: {
  gone: number;
  buyableCount: number;
  messageCount: number;
  onRefill: () => void;
  onReport: () => void;
}): ReactNode {
  return (
    <>
      <div className="row">
        <button type="button" className="btn-secondary" disabled={buyableCount === 0} onClick={onRefill}>
          <RefreshCw size={16} /> Buy again
        </button>
        <button type="button" className="btn-primary" onClick={onReport}>
          <AlertCircle size={16} /> Report an issue
        </button>
      </div>
      {messageCount > 0 ? <p className="muted small">Latest update in this order thread.</p> : null}
      {gone > 0 ? <p className="muted small">{gone} item(s) no longer in the catalogue.</p> : null}
    </>
  );
}

/** The lines of one order, as bought. Facts, not a re-order form. */
function OrderLines({ items }: { items: ShopOrder['items'] }): ReactNode {
  return (
    <ul className="lines">
      {items.map((item, index) => (
        <li key={`${item.name}-${index}`}>
          <span>
            {item.name} <span className="muted">x{item.quantity}</span>
          </span>
          <span className="num">{money(item.unitPriceCents * item.quantity)}</span>
        </li>
      ))}
    </ul>
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
      <h2 className="label">Tell us what went wrong</h2>
      <p className="muted small">We’ll open your {order.id} thread so you can add more detail if needed.</p>
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
