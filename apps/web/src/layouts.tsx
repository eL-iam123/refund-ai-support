import { useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  FileText,
  Headset,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  ShieldCheck,
  ShoppingBag,
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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            Refund Store
            <small>the policy decides; the model only explains</small>
          </div>
        </div>
        <nav>
          <NavLink to="/"><ShoppingBag size={16} /> Shop</NavLink>
          <NavLink to="/cart"><ShoppingCart size={16} /> Cart{count > 0 ? ` (${count})` : ''}</NavLink>
          <NavLink to="/orders"><Package size={16} /> Orders</NavLink>
          <NavLink to="/help"><MessageSquare size={16} /> Get help</NavLink>
          <NavLink to="/account"><User size={16} /> Account</NavLink>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <p className="muted small">
          A demo storefront. Every order here is real, in the same database the refund policy reads.
        </p>
      </footer>
    </div>
  );
}

export function AdminLayout(): ReactNode {
  const signedIn = useStaffSession();
  return (
    <div className="app">
      <header className="topbar topbar-admin">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            Refund review
            <small>every decision, and the reasoning behind it</small>
          </div>
        </div>
        <nav>
          <NavLink to="/admin"><LayoutDashboard size={16} /> Queue</NavLink>
          <NavLink to="/admin/live"><Headset size={16} /> Live</NavLink>
          <NavLink to="/admin/refunds"><Wallet size={16} /> Payouts</NavLink>
          <NavLink to="/admin/requests"><Inbox size={16} /> All requests</NavLink>
          <NavLink to="/admin/policy"><FileText size={16} /> Policy</NavLink>
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
