import { useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  ClipboardCheck,
  FileText,
  Headset,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  ShieldCheck,
  ShoppingBag,
  Search,
  ShoppingCart,
  User,
  Wallet,
} from 'lucide-react';
import { isSignedIn, onStaffSessionChange, setStaffSession } from './auth';
import { api } from './api';
import { cartCount, subscribeToCart } from './shop/cartStore';

/**
 * Two surfaces, one bundle, and the line between them is a route.
 *
 * The shopper half - shop, cart, orders, help, account - is the
 * product. Someone buying a lamp and then complaining about it never sees a word
 * about dashboards, rule traces or tokens, and there is no link anywhere on that
 * half that would take them there.
 *
 * The staff half sits under `/admin` behind its own header. That is structural
 * rather than a styling trick: a reviewer reading a decision is never one
 * misclick from the storefront, and the storefront is not cluttered with links
 * 99% of visitors cannot use.
 *
 * Both halves are in one bundle because this is one demo binary. The boundary a
 * real deployment enforces is the one `StaffGate` models - the API refuses every
 * staff route without a session - so a hidden link is convenience, not security.
 */
export function ShopperLayout(): ReactNode {
  const count = useCartCount();
  return (
    <div className="app shopper-app">
      <header className="topbar">
        <NavLink className="brand" to="/" aria-label="Refund Store home">
          <span className="brand-mark">R</span>
          <div>
            Refund Store
            <small>everyday finds, clearly handled</small>
          </div>
        </NavLink>
        <div className="shop-search" role="search">
          <Search size={18} aria-hidden="true" />
          <span>What are you looking for?</span>
        </div>
        <nav aria-label="Shop navigation">
          <NavLink to="/"><ShoppingBag size={18} aria-hidden="true" /><span>Shop</span></NavLink>
          <NavLink to="/orders"><Package size={18} aria-hidden="true" /><span>Orders</span></NavLink>
          <NavLink to="/help"><MessageSquare size={18} aria-hidden="true" /><span>Help</span></NavLink>
          <NavLink to="/account"><User size={18} aria-hidden="true" /><span>Account</span></NavLink>
          <NavLink to="/cart" className="cart-link"><ShoppingCart size={18} aria-hidden="true" /><span>Cart</span>{count > 0 && <b>{count}</b>}</NavLink>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function AdminLayout(): ReactNode {
  const signedIn = useStaffSession();
  return (
    <div className="app admin-app">
      <header className="topbar topbar-admin">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            Refund Console
            <small>operations</small>
          </div>
        </div>
        <nav aria-label="Staff navigation">
          <NavLink to="/admin" end><LayoutDashboard size={16} aria-hidden="true" /> Overview</NavLink>
          <NavLink to="/admin/live"><Headset size={16} aria-hidden="true" /> Live</NavLink>
          <NavLink to="/admin/refunds"><Wallet size={16} aria-hidden="true" /> Payouts</NavLink>
          <NavLink to="/admin/returns"><Package size={16} aria-hidden="true" /> Returns</NavLink>
          <NavLink to="/admin/requests"><Inbox size={16} aria-hidden="true" /> All requests</NavLink>
          <NavLink to="/admin/scenarios"><ClipboardCheck size={16} aria-hidden="true" /> Scenarios</NavLink>
          <NavLink to="/admin/policy"><FileText size={16} aria-hidden="true" /> Policy</NavLink>
          {signedIn ? (
            <button type="button" className="linkish" onClick={() => void signOut()}>
              <LogOut size={16} /> Sign out
            </button>
          ) : null}
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <p className="muted small">
          <ShieldCheck size={14} /> Staff area. Read the rule trace before overuling the resolver -
          an override that contradicts a blocking rule is refused by the API.
        </p>
      </footer>
    </div>
  );
}

function useCartCount(): number {
  return useSyncExternalStore(subscribeToCart, cartCount, () => 0);
}

function useStaffSession(): boolean {
  return useSyncExternalStore(onStaffSessionChange, isSignedIn, () => false);
}

/**
 * Clears the session cookie, then the local copy of who was signed in.
 *
 * Local state first is deliberate: the cookie is gone either way, and a failed
 * logout call should not leave a header claiming somebody is still signed in.
 */
async function signOut(): Promise<void> {
  try {
    await api.signOut();
  } finally {
    setStaffSession(null);
  }
}
