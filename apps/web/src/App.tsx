import { type ReactNode } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { ChatPage } from './ChatPage';
import { DashboardPage } from './DashboardPage';
import { AdminLayout, ShopperLayout } from './layouts';
import { PolicyPage } from './PolicyPage';
import { RefundsPage } from './RefundsPage';
import { RequestDetailPage } from './RequestDetailPage';
import { RequestsPage } from './RequestsPage';
import { ScenariosPage } from './ScenariosPage';
import { StaffGate } from './StaffGate';
import { useAsyncData, useSession, Spinner } from './shop/hooks';
import { addToCart, cartLines, refillCart, clearCart, type CartLine } from './shop/cartStore';
import { shopApi, type Product } from './shop/api';
import { AccountPage } from './shop/Account';
import { Cart } from './shop/Cart';
import { Catalogue } from './shop/Catalogue';
import { Orders } from './shop/Orders';

/**
 * The shop and the staff console, in one bundle and two layouts.
 *
 * The storefront and the assistant are the same app on purpose: someone buys a
 * lamp, decides it is faulty, and complains about it, all in one tab. So the
 * shop, cart, orders, account and assistant share a topbar and a
 * httpOnly session cookie, and "report an issue" is a route change carrying the
 * order across rather than a second sign-in.
 *
 * The staff pages are here because it is one demo binary, and they are under
 * `/admin` behind `StaffGate` with a header of their own. The shopper's nav has
 * no link to any of it: an admin link on a shop page is a link a customer can
 * follow into a sign-in prompt they have no reason to see.
 */
export function App(): ReactNode {
  return (
    <Routes>
      <Route element={<ShopperLayout />}>
        <Route path="/" element={<ShopRoute />} />
        <Route path="/cart" element={<CartRoute />} />
        <Route path="/orders" element={<OrdersRoute />} />
        <Route path="/account" element={<AccountRoute />} />
        <Route path="/help" element={<ChatPage />} />
        <Route path="*" element={<p className="empty">No such page.</p>} />
      </Route>

      <Route
        path="/admin"
        element={
          <StaffGate>
            <AdminLayout />
          </StaffGate>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="refunds" element={<RefundsPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestDetailPage />} />
        <Route path="scenarios" element={<ScenariosPage />} />
        <Route path="policy" element={<PolicyPage />} />
      </Route>
    </Routes>
  );
}

/** How many of a given product are already in the cart. */
function quantityIn(lines: readonly CartLine[]): (productId: string) => number {
  return (productId) => lines.find((line) => line.productId === productId)?.quantity ?? 0;
}

/** The catalogue is session-independent, so it is fetched once and shared. */
function useCatalogue(): { products: readonly Product[]; loading: boolean; error: string | null } {
  const catalogue = useAsyncData(() => shopApi.products().then((result) => result.products), ['products']);
  return {
    products: catalogue.data ?? [],
    loading: catalogue.data === null,
    error: catalogue.error,
  };
}

function ShopRoute(): ReactNode {
  const { products, loading, error } = useCatalogue();
  return (
    <div className="stack">
      <div>
        <h1>Everything here is worth testing</h1>
        <p className="lede">
          Each product exists to make the refund assistant show a different behaviour. Buy
          something, then tell it what went wrong.
        </p>
      </div>
      {error !== null ? <p className="error">{error}</p> : null}
      {loading ? <Spinner /> : <Catalogue products={products} onAdd={addToCart} inCart={quantityIn(cartLines())} />}
    </div>
  );
}

function CartRoute(): ReactNode {
  const { products, loading } = useCatalogue();
  const session = useSession();
  const navigate = useNavigate();
  if (loading) {
    return <Spinner />;
  }
  return (
    <Cart
      products={products}
      lines={cartLines()}
      signedIn={session.user !== null}
      onClear={clearCart}
      onPlaced={() => void navigate('/orders')}
    />
  );
}

function OrdersRoute(): ReactNode {
  const session = useSession();
  const navigate = useNavigate();
  const orders = useAsyncData(() => shopApi.orders(), ['orders']);
  if (orders.data === null) {
    return <Spinner />;
  }
  return (
    <Orders
      orders={orders.data.orders}
      signedIn={session.user !== null}
      onRefill={refillCart}
      onBrowse={() => void navigate('/')}
    />
  );
}

function AccountRoute(): ReactNode {
  const session = useSession();
  return (
    <AccountPage
      session={session}
      onSignedIn={() => {
        // The session changed, so anything keyed to it is re-read on next mount.
        void session.refresh();
      }}
    />
  );
}
