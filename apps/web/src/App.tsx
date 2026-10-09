import React, { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ChatPage } from './ChatPage';
import { DashboardPage } from './DashboardPage';
import { AdminLayout, ShopperLayout } from './layouts';
import { PolicyPage } from './PolicyPage';
import { RefundsPage } from './RefundsPage';
import { ReturnsPage } from './ReturnsPage';
import { RequestDetailPage } from './RequestDetailPage';
import { RequestsPage } from './RequestsPage';
import { ScenariosPage } from './ScenariosPage';
import { LiveConversationsPage } from './LiveConversationsPage';
import { StaffGate } from './StaffGate';
import { useAsyncData, useSession, Spinner } from './shop/hooks';
import { addToCart, cartLines, refillCart, clearCart, subscribeToCart, type CartLine } from './shop/cartStore';
import { shopApi, type Product } from './shop/api';
import { api } from './api';
import { AccountPage } from './shop/Account';
import { Cart } from './shop/Cart';
import { Catalogue } from './shop/Catalogue';
import { OrderDetails, Orders } from './shop/Orders';

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
    <CrashBoundary>
      <Routes>
      <Route element={<ShopperLayout />}>
        <Route path="/" element={<ShopRoute />} />
        <Route path="/cart" element={<CartRoute />} />
        <Route path="/orders" element={<OrdersRoute />} />
        <Route path="/orders/:id" element={<OrderDetailRoute />} />
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
        <Route path="returns" element={<ReturnsPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:id" element={<RequestDetailPage />} />
        <Route path="scenarios" element={<ScenariosPage />} />
        <Route path="policy" element={<PolicyPage />} />
      </Route>
      </Routes>
    </CrashBoundary>
  );
}

/**
 * The last thing between a render fault and a blank page.
 *
 * Every list here reads a field off a record the server sent, so one unexpected
 * shape - a column added, a field renamed, a null where a string was - used to
 * throw during render and leave an operator staring at an empty white rectangle
 * with no way forward except a refresh. That is the worst possible failure for the
 * console: the person whose job is to fix things is the one who cannot see them.
 *
 * So a fault is caught, named, and made recoverable. It shows the error rather than
 * swallowing it, because the alternative - a page that merely says "something went
 * wrong" - is how a real bug gets reported as "the site is down".
 */
function CrashBoundary({ children }: { children: ReactNode }): ReactNode {
  const [fault, setFault] = useState<Error | null>(null);

  if (fault !== null) {
    return (
      <div className="app">
        <main className="main">
          <h1>This page could not be shown</h1>
          <p className="lede">
            Something on this page did not look the way it expected. Nothing has been lost - nothing
            was saved - and reloading usually clears it.
          </p>
          <p className="mono small">{fault.message}</p>
          <button type="button" onClick={(): void => globalThis.location.reload()}>
            Reload
          </button>
        </main>
      </div>
    );
  }

  return <RenderTrap onFault={setFault}>{children}</RenderTrap>;
}

/**
 * Catches what a descendant throws while rendering.
 *
 * A class, because `componentDidCatch` is the only way React offers to see an
 * error thrown below you, and there is no hook equivalent.
 */
class RenderTrap extends React.Component<
  { onFault: (error: Error) => void; children: ReactNode },
  Record<string, never>
> {
  override componentDidCatch(error: Error): void {
    this.props.onFault(error);
  }

  override render(): ReactNode {
    return this.props.children;
  }
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
  // Same subscription as the cart page: without it the per-product counts go
  // stale the moment a line is removed elsewhere.
  const lines = useSyncExternalStore(subscribeToCart, cartLines);
  return (
    <div className="stack shop-home">
      <section className="shop-hero">
        <div>
          <h1>Store.com</h1>
          <p className="lede">Whatever it is you are looking for we have it.</p>
        </div>
      </section>
      <div className="section-heading"><h2>Shop products</h2><span className="muted small">Delivery options shown at checkout</span></div>
      {error !== null ? <p className="error">{error}</p> : null}
      {loading ? <Spinner /> : <Catalogue products={products} onAdd={addToCart} inCart={quantityIn(lines)} />}
    </div>
  );
}

function CartRoute(): ReactNode {
  const { products, loading } = useCatalogue();
  const session = useSession();
  const navigate = useNavigate();
  // Subscribed, not snapshotted: removal replaces the store array, and a
  // one-time read would keep the removed row and submit it at checkout.
  const lines = useSyncExternalStore(subscribeToCart, cartLines);
  if (loading) {
    return <Spinner />;
  }
  return (
    <Cart
      products={products}
      lines={lines}
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

function OrderDetailRoute(): ReactNode {
  const { id } = useParams();
  const navigate = useNavigate();
  const orders = useAsyncData(() => shopApi.orders(), ['orders']);
  const order = orders.data?.orders.find((candidate) => candidate.id === id);
  if (orders.data === null) return <Spinner />;
  if (order === undefined) return <p className="empty">Order not found.</p>;
  return <OrderDetails order={order} onBack={() => void navigate('/orders')} onReport={() => void navigate(`/help?order=${encodeURIComponent(order.id)}`)} />;
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
