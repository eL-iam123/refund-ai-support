import type { ReactNode } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { shopApi, type Product } from './api';
import { useAsyncData, useCart, useSession, Spinner, type SessionState } from './hooks';
import { Catalogue } from './Catalogue';
import { Cart } from './Cart';
import { Orders } from './Orders';
import { AccountPage } from './Account';

/**
 * The storefront.
 *
 * One origin, two apps: the API serves this at `/shop/` and the staff console
 * at `/`. Serving them together is what lets the session cookie be same-origin,
 * which is why a refund request made from a shop page can be attributed to a
 * real customer without a token ever being readable by the browser.
 *
 * Each page owns the data it needs. The catalogue is fetched once here because
 * the cart and the product grid both need it; orders belong to the orders page
 * and are fetched there, so signing in does not have to re-plumb them.
 */
export function App(): ReactNode {
  const session = useSession();
  const cart = useCart();
  const catalogue = useAsyncData(
    () => shopApi.products().then((result) => result.products),
    [],
  );

  return (
    <div className="shop">
      <Topbar session={session} cartCount={cart.count} />
      <main className="main">
        <ShopRoutes session={session} cart={cart} catalogue={catalogue} />
      </main>
      <footer className="footer">
        <p className="muted small">
          A demo storefront for the refund assistant. Every order here is real, in the same database
          the decision engine reads.
        </p>
        <CustomerIdWarning />
      </footer>
    </div>
  );
}

interface CatalogueState {
  data: readonly Product[] | null;
  error: string | null;
  reload: () => void;
}

function Topbar({ session, cartCount }: { session: SessionState; cartCount: number }): ReactNode {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">W</span>
        <span>
          WORKNOON
          <small>goods that behave</small>
        </span>
      </div>
      <nav>
        <NavLink to="/shop">Shop</NavLink>
        <NavLink to="/shop/cart">Cart{cartCount > 0 ? ` (${cartCount})` : ''}</NavLink>
        <NavLink to="/shop/orders">Orders</NavLink>
        <NavLink to="/shop/account">{session.user === null ? 'Sign in' : session.user.email}</NavLink>
      </nav>
    </header>
  );
}

/** All the routes, kept apart from the chrome so both stay readable. */
function ShopRoutes({
  session,
  cart,
  catalogue,
}: {
  session: SessionState;
  cart: ReturnType<typeof useCart>;
  catalogue: CatalogueState;
}): ReactNode {
  const navigate = useNavigate();
  const products: readonly Product[] = catalogue.data ?? [];

  return (
    <Routes>
      <Route
        path="/shop"
        element={
          <ShopView
            products={products}
            loading={catalogue.data === null}
            error={catalogue.error}
            onAdd={cart.add}
            inCart={(id) => cart.lines.find((line) => line.productId === id)?.quantity ?? 0}
          />
        }
      />
      <Route
        path="/shop/cart"
        element={
          <Cart
            products={products}
            lines={cart.lines}
            signedIn={session.user !== null}
            onClear={cart.clear}
            onPlaced={() => {
              void navigate('/shop/orders');
            }}
          />
        }
      />
      <Route
        path="/shop/orders"
        element={<OrdersRoute onBought={() => void navigate('/shop')} />}
      />
      <Route
        path="/shop/account"
        element={
          <AccountPage
            session={session}
            onSignedIn={() => {
              // The session changed, so anything keyed to it has to be re-read.
              void session.refresh().then(catalogue.reload);
            }}
          />
        }
      />
      <Route path="*" element={<p className="muted">No such page.</p>} />
    </Routes>
  );
}

function OrdersRoute({ onBought }: { onBought: () => void }): ReactNode {
  const orders = useAsyncData(() => shopApi.orders(), []);

  if (orders.data === null) {
    return <Spinner />;
  }
  return (
    <Orders
      orders={orders.data.orders}
      user={orders.data.user?.customerId ?? null}
      onBought={onBought}
    />
  );
}

function ShopView({
  products,
  loading,
  error,
  onAdd,
  inCart,
}: {
  products: readonly Product[];
  loading: boolean;
  error: string | null;
  onAdd: (productId: string) => void;
  inCart: (productId: string) => number;
}): ReactNode {
  return (
    <>
      <h1>Everything here is worth testing</h1>
      <p className="lede">
        Each product exists to make the refund assistant show a different behaviour. Buy something,
        then tell it what went wrong.
      </p>
      {error !== null && <p className="error">{error}</p>}
      {loading ? <Spinner /> : <Catalogue products={products} onAdd={onAdd} inCart={inCart} />}
    </>
  );
}

/**
 * The one thing a tester needs to know.
 *
 * Signed in, the customer id comes from the server session and the field in the
 * refund request is ignored. Signed out, the public chat endpoint still believes
 * whatever `customerId` it is given - so the *staff* console is the place to
 * explore that, and nothing in this shop depends on it being believed.
 */
function CustomerIdWarning(): ReactNode {
  return (
    <p className="muted small">
      <strong>Known limitation:</strong> the public refund endpoint trusts a <code>customerId</code>{' '}
      in the request body when there is no session. Signing in here overrides it, but no part of
      this shop relies on that field being believed.
    </p>
  );
}
