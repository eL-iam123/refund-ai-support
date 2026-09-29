import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { describe, money, shopApi, type Product, type ShopUser } from './api';
import type { SessionState } from './hooks';

/**
 * Sign in, register, or take a demo identity.
 *
 * The demo buttons are the fastest route in and are the reason a tester can see
 * a decision in under a minute. The password form is there for a shopper who
 * wants an account of their own, and both paths end at the same server-side
 * session - the demo shortcut is a convenience, not a different kind of login.
 */
export function AccountPage({
  session,
  onSignedIn,
}: {
  session: SessionState;
  onSignedIn: () => void;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!session.ready) {
    return <p className="muted">Checking your session…</p>;
  }

  if (session.user !== null) {
    return <SignedIn user={session.user} session={session} onSignedIn={onSignedIn} />;
  }

  return (
    <div className="two-col">
      <SignInForm error={error} busy={busy} setError={setError} setBusy={setBusy} onDone={onSignedIn} />
      <DemoAccounts error={error} setError={setError} setBusy={setBusy} onDone={onSignedIn} />
      <RegisterForm onDone={onSignedIn} />
    </div>
  );
}

function SignedIn({
  user,
  session,
  onSignedIn,
}: {
  user: ShopUser;
  session: SessionState;
  onSignedIn: () => void;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card wide">
      <h2>Signed in</h2>
      <p>
        <strong>{user.email}</strong>
        {user.isDemo && <span className="flag-info"> demo account</span>}
      </p>
      <p className="muted mono">customer id: {user.customerId}</p>
      <p className="muted">
        Your customer id is what the refund assistant uses to find your orders. You never need to
        type it.
      </p>
      <button
        type="button"
        onClick={() => {
          void session
            .signOut()
            .then(onSignedIn)
            .catch((cause: unknown) => setError(describe(cause)));
        }}
      >
        Sign out
      </button>
      {error !== null && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

interface FormProps {
  readonly error: string | null;
  readonly busy: boolean;
  readonly setError: (message: string | null) => void;
  readonly setBusy: (busy: boolean) => void;
  readonly onDone: () => void;
}

async function run(
  setError: (message: string | null) => void,
  setBusy: (busy: boolean) => void,
  onDone: () => void,
  action: () => Promise<unknown>,
): Promise<void> {
  setError(null);
  setBusy(true);
  try {
    await action();
    onDone();
  } catch (cause: unknown) {
    setError(describe(cause));
  } finally {
    setBusy(false);
  }
}

function SignInForm({ error, busy, setError, setBusy, onDone }: FormProps): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="card"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void run(setError, setBusy, onDone, () => shopApi.login(email, password));
      }}
    >
      <h2>Sign in</h2>
      <label htmlFor="login-email">Email</label>
      <input
        id="login-email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label htmlFor="login-password">Password</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" disabled={busy || email.length === 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

function DemoAccounts({ error, setError, setBusy, onDone }: Omit<FormProps, 'busy'>): ReactNode {
  const [accounts, setAccounts] = useState<readonly ShopUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void shopApi
      .demoAccounts()
      .then((result) => {
        if (live) setAccounts(result.accounts);
      })
      .catch((cause: unknown) => {
        if (live) setLoadError(describe(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="card">
      <h2>Try a demo shopper</h2>
      <p className="muted">
        Each has a password-free sign-in and a couple of past orders, so you can go straight to
        reporting a problem.
      </p>
      {loadError !== null && <p className="error">{loadError}</p>}
      {accounts?.map((account) => (
        <button
          key={account.email}
          type="button"
          className="demo"
          onClick={() =>
            void run(setError, setBusy, onDone, () => shopApi.demoLogin(account.email))
          }
        >
          {account.email}
        </button>
      ))}
      <ErrorLine error={error} />
    </section>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void run(setError, setBusy, onDone, () => shopApi.register(email, password, name));
      }}
    >
      <h2>Create an account</h2>
      <label htmlFor="reg-name">Name</label>
      <input id="reg-name" value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="reg-email">Email</label>
      <input
        id="reg-email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <label htmlFor="reg-password">Password (8+ characters)</label>
      <input
        id="reg-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

function ErrorLine({ error }: { error: string | null }): ReactNode {
  return error === null ? null : (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

/** Kept next to the account page: both are about who the shopper is. */
export function CartSummary({
  products,
  lines,
  totalCents,
}: {
  products: readonly Product[];
  lines: readonly { productId: string; quantity: number }[];
  totalCents: number;
}): ReactNode {
  if (lines.length === 0) {
    return <p className="muted">Your cart is empty.</p>;
  }
  return (
    <ul className="lines">
      {lines.map((line) => {
        const product = products.find((p) => p.id === line.productId);
        return (
          <li key={line.productId}>
            <span>
              {product?.name ?? line.productId} &times; {line.quantity}
            </span>
            <span className="num">{money((product?.priceCents ?? 0) * line.quantity)}</span>
          </li>
        );
      })}
      <li className="total">
        <span>Total</span>
        <span className="num">{money(totalCents)}</span>
      </li>
    </ul>
  );
}
