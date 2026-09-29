import { useState, type ReactNode } from 'react';
import { describe, money, shopApi, type Product, type ShopOrder } from './api';
import { CartSummary } from './Account';
import type { CartLine } from './hooks';

/**
 * Cart and checkout.
 *
 * The total shown here is computed from the catalogue for display, but the total
 * that ends up on the order is computed by the server from its own rows. They
 * agree here, and only the server's version matters - so the number is labelled
 * as an estimate rather than presented as the bill.
 */
/** Shown once checkout succeeds, in place of the cart. */
function Placed({ order, onDismiss }: { order: ShopOrder; onDismiss: () => void }): ReactNode {
  return (
    <section className="card wide">
      <h2>Order placed</h2>
      <p className="mono">{order.id}</p>
      <p className="row">
        <span className="num">{money(order.totalCents)}</span>
        <span className="muted">
          paid · {order.trackingStatus}
        </span>
      </p>
      <p className="muted">
        It is in your order history now. Report a problem against it to watch the refund engine work
        on something you just bought.
      </p>
      <button type="button" onClick={onDismiss}>
        Back to the cart
      </button>
    </section>
  );
}

function CheckoutButton({
  canPay,
  busy,
  estimateCents,
  onPay,
}: {
  canPay: boolean;
  busy: boolean;
  estimateCents: number;
  onPay: () => void;
}): ReactNode {
  return (
    <button type="button" disabled={!canPay || busy} onClick={onPay}>
      {busy ? 'Placing order…' : `Check out · ${money(estimateCents)}`}
    </button>
  );
}

export function Cart({
  products,
  lines,
  signedIn,
  onClear,
  onPlaced,
}: {
  products: readonly Product[];
  lines: readonly CartLine[];
  signedIn: boolean;
  onClear: () => void;
  onPlaced: (order: ShopOrder) => void;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<ShopOrder | null>(null);

  const estimate = lines.reduce((sum, line) => {
    const product = products.find((p) => p.id === line.productId);
    return sum + (product?.priceCents ?? 0) * line.quantity;
  }, 0);

  if (placed !== null) {
    return <Placed order={placed} onDismiss={() => setPlaced(null)} />;
  }

  return (
    <section className="card wide">
      <h2>Your cart</h2>
      <CartSummary products={products} lines={lines} totalCents={estimate} />
      {lines.length > 0 && (
        <p className="muted small">
          The order total is recalculated by the server at checkout; this figure is a preview.
        </p>
      )}
      {!signedIn && lines.length > 0 && (
        <p className="note">Sign in to check out. Your cart stays put.</p>
      )}
      <CheckoutButton
        canPay={signedIn && lines.length > 0}
        busy={busy}
        estimateCents={estimate}
        onPay={() => {
          setBusy(true);
          setError(null);
          void shopApi
            .checkout(lines)
            .then((result) => {
              onClear();
              onPlaced(result.order);
            })
            .catch((cause: unknown) => setError(describe(cause)))
            .finally(() => setBusy(false));
        }}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
