import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { isSignedIn, setStaffSession } from './auth';
import { api, describe } from './api';

/**
 * Staff sign-in.
 *
 * A username and a password, submitted to `POST /api/admin/login` and exchanged
 * for an httpOnly cookie. The page never sees a token, which is the point: there
 * is no credential in JavaScript that a script injected into the storefront could
 * read and replay against the console.
 *
 * Both halves of a wrong pair get the same answer from the server, so this form
 * does not have to decide what to say about which half was wrong - and does not
 * have to be careful not to leak that itself.
 */

type Status = 'idle' | 'checking' | 'invalid' | 'valid';

/** Wraps the staff-only pages. Public pages deliberately do not use it. */
export function StaffGate({ children }: { children: ReactNode }): ReactNode {
  const [session, setSession] = useState(isSignedIn());

  // An existing cookie is honoured on mount, so a reload does not ask for a
  // password that is still valid. The 401 is the ordinary "not signed in" answer
  // and is deliberately not surfaced.
  useEffect(() => {
    let live = true;
    void api
      .staffSession()
      .then((current) => {
        if (live) {
          setStaffSession(current);
          setSession(true);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return session ? <>{children}</> : <CredentialForm onSignedIn={setSession} />;
}

function CredentialForm({ onSignedIn }: { onSignedIn: (signedIn: boolean) => void }): ReactNode {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus('checking');
    setError('');
    try {
      const current = await api.signIn(username, password);
      setStaffSession(current);
      // The password is dropped from component state the moment it is no longer
      // needed, so it does not sit in a React tree waiting to be read.
      setPassword('');
      setStatus('valid');
      onSignedIn(true);
    } catch (cause) {
      setStatus('invalid');
      setError(describe(cause));
    }
  }

  const busy = status === 'checking';

  return (
    <section className="gate">
      <h1>Staff access</h1>
      <GateCopy />
      <form onSubmit={(event) => void submit(event)}>
        <Credential
          id="staff-username"
          label="Username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(next) => {
            setUsername(next);
            setStatus('idle');
          }}
        />
        <Credential
          id="staff-password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(next) => {
            setPassword(next);
            setStatus('idle');
          }}
        />
        <button type="submit" disabled={busy || username.trim().length === 0 || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <GateStatus status={status} error={error} />
    </section>
  );
}

/**
 * The one thing worth reporting, and nothing else.
 *
 * A 401 is not shown as a wall of text: the server already declines to say which
 * half of the credential was wrong, and repeating either half here would be the
 * place that undoes that.
 */
function GateStatus({ status, error }: { status: Status; error: string }): ReactNode {
  if (status === 'invalid') {
    return (
      <p className="gate-error" role="alert">
        {error}
      </p>
    );
  }
  if (status === 'valid') {
    return <p className="gate-ok">Signed in</p>;
  }
  return null;
}

/** One labelled input. `spellCheck` is off throughout: a credential is not prose. */
function Credential({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type: 'text' | 'password';
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}

/**
 * What the form is and what a session is, kept out of the component so the
 * component is a form and the explanations are somewhere they can be read and
 * changed on their own.
 */
function GateCopy(): ReactNode {
  return (
    <>
      <p>
        This area lists customers, their orders and every decision, so it is closed to anonymous
        callers. Sign in with the operator account configured in <code>.env</code>; the demo
        credentials are in <code>admin-login.txt</code>.
      </p>
      <p className="gate-note">
        The session lives in an httpOnly cookie for eight hours, so this tab holds nothing a script
        could read. Signing out clears the cookie; changing <code>ADMIN_API_SECRET</code> invalidates
        every outstanding session at once.
      </p>
    </>
  );
}
