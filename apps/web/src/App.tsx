import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { ChatPage } from './ChatPage';
import { DashboardPage } from './DashboardPage';
import { PolicyPage } from './PolicyPage';
import { RefundsPage } from './RefundsPage';
import { RequestDetailPage } from './RequestDetailPage';
import { RequestsPage } from './RequestsPage';
import { ScenariosPage } from './ScenariosPage';
import { StaffGate } from './StaffGate';
import { clearStaffToken, onStaffTokenChange, staffToken } from './auth';

/**
 * Two surfaces, one origin.
 *
 * `/` is what a customer sees. `/admin` is what a reviewer sees, and it is the
 * only place the rule trace is exposed - the same decision, with the reasoning
 * attached, reachable from the customer's own "why?" link.
 */
export function App(): ReactNode {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RD</span>
          <span>
            Refund Desk
            <small>the policy decides; the model only explains</small>
          </span>
        </div>
        <nav>
          <NavLink to="/">Customer</NavLink>
          <NavLink to="/admin">Dashboard</NavLink>
          <NavLink to="/admin/refunds">Refunds</NavLink>
          <NavLink to="/admin/requests">Requests</NavLink>
          <NavLink to="/admin/scenarios">Scenarios</NavLink>
          <NavLink to="/admin/policy">Policy</NavLink>
          <SignOutControl />
        </nav>
        <ProviderBadge />
      </header>

      <main className="main">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/admin" element={<StaffGate><DashboardPage /></StaffGate>} />
          <Route
            path="/admin/refunds"
            element={<StaffGate><RefundsPage /></StaffGate>}
          />
          <Route
            path="/admin/requests"
            element={<StaffGate><RequestsPage /></StaffGate>}
          />
          <Route
            path="/admin/requests/:id"
            element={<StaffGate><RequestDetailPage /></StaffGate>}
          />
          <Route
            path="/admin/scenarios"
            element={<StaffGate><ScenariosPage /></StaffGate>}
          />
          <Route path="/admin/policy" element={<PolicyPage />} />
          <Route path="*" element={<p className="empty">No such page.</p>} />
        </Routes>
      </main>
    </div>
  );
}

/** Only rendered when a session exists, so the button has something to end. */
function SignOutControl(): ReactNode {
  const token = useSyncExternalStore(onStaffTokenChange, staffToken, () => null);

  if (token === null) {
    return null;
  }
  return (
    <button type="button" className="linkish" onClick={clearStaffToken}>
      Sign out
    </button>
  );
}

/** Shows which provider answered, because "is this a real model?" is the first question. */
function ProviderBadge(): ReactNode {
  const [mode, setMode] = useState<string>('');

  useEffect(() => {
    void api
      .health()
      .then((result) => setMode(result.aiMode))
      .catch(() => setMode('api unreachable'));
  }, []);

  return <span className="provider">{mode.length > 0 ? mode : 'connecting…'}</span>;
}
