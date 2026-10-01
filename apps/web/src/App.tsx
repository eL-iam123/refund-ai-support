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
import { LiveConversationsPage } from './LiveConversationsPage';
import { StaffGate } from './StaffGate';
import { useAsyncData, useSession, Spinner } from './shop/hooks';
import { addToCart, cartLines, refillCart, clearCart, type CartLine } from './shop/cartStore';
import { shopApi, type Product } from './shop/api';
import { api } from './api';
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
          <AdminArea>
            <StaffGate>
              <AdminLayout />
            </StaffGate>
          </AdminArea>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="live" element={<LiveConversationsPage />} />
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

/**
 * Whether this deployment has a staff console at all.
 *
 * `/api/health` answers `adminEnabled`, which is false until an operator account
 * is configured. Rendering the console's children on that answer rather than
 * hiding a link is the difference between "no console" and "a console that
 * cannot log you in": the first reads as a product decision, the second as a
 * broken deployment. The API answers 404 for the staff routes either way, so this
 * is presentation, not the control - the control is server-side and unconditional.
 */
function useAdminEnabled(): boolean | null {
  const health = useAsyncData(() => api.health(), ['health']);
  if (health.data === null) {
    return null;
  }
  return health.data.adminEnabled;
}

function AdminArea({ children }: { children: ReactNode }): ReactNode {
  const adminEnabled = useAdminEnabled();
  if (adminEnabled === null) {
    return <Spinner />;
  }
  if (!adminEnabled) {
    return <AdminDisabled />;
  }
  return <>{children}</>;
}

function AdminDisabled(): ReactNode {
  return (
    <div className="app">
      <main className="main">
        <h1>No staff console</h1>
        <p className="lede">
          This deployment has no operator account, so the console is not part of the product. The
          shopper side is unaffected.
        </p>
        <p>
          To switch it on, put a username and password in <code>.env</code> and restart. The demo
          pair is in <code>admin-login.txt</code>; generate your own with{' '}
          <code>openssl rand -base64 24</code>.
        </p>
        <p>
          <a href="/">Back to the shop</a>
        </p>
      </main>
    </div>
  );
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
      <section className="shop-hero">
        <div>
          <p className="eyebrow">Official storefront</p>
          <h1>Good things, clearly priced.</h1>
          <p className="lede">Shop practical finds, then manage every order from one simple account.</p>
        </div>
        <div className="hero-stat"><strong>6</strong><span>items ready to ship</span></div>
      </section>
      <div className="section-heading"><div><p className="eyebrow">Featured catalogue</p><h2>Popular right now</h2></div><span className="muted small">Delivery options shown at checkout</span></div>
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
  const counts = useAsyncData(() => shopApi.chatSummary(), ['chat-summary']);
  if (orders.data === null) {
    return <Spinner />;
  }
  return (
    <Orders
      orders={orders.data.orders}
      signedIn={session.user !== null}
      counts={counts.data?.counts ?? []}
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
