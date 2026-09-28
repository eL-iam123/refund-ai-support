import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { onStaffTokenChange, setStaffToken, staffToken } from './auth';
import { api, describe } from './api';

/**
 * Staff sign-in.
 *
 * A token is pasted, not exchanged for. There is no password form and no token
 * endpoint here, on purpose: an endpoint that issues admin credentials to
 * anonymous callers would be a larger hole than the one this gate closes.
 *
 * The token is checked against the least-privileged staff route before the
 * session is accepted, so a typo produces "that is not a valid staff token"
 * rather than a dashboard full of failed requests.
 */

type Status = 'idle' | 'checking' | 'invalid' | 'valid';

/** Wraps the staff-only pages. Public pages deliberately do not use it. */
export function StaffGate({ children }: { children: ReactNode }): ReactNode {
  const token = useSyncExternalStore(onStaffTokenChange, staffToken, () => null);
  const [rejected, setRejected] = useState(false);

  // A rejected token was already cleared, so `token` is null here. Rendering the
  // form instead of the children keeps a bad credential from flickering through
  // a page that will only fail every one of its requests.
  return token !== null && !rejected ? <>{children}</> : <TokenForm onRejected={setRejected} />;
}

/** The credential prompt, including the one valid state worth reporting. */
function TokenForm({ onRejected }: { onRejected: (rejected: boolean) => void }): ReactNode {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState('');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus('checking');
    setDetail('');
    // Install before verifying so the probe request itself carries the token.
    setStaffToken(draft);
    try {
      const { requests } = await api.listRequests();
      setStatus('valid');
      setDetail(`${requests.length} request(s) visible`);
    } catch (cause) {
      setStaffToken('');
      onRejected(true);
      setStatus('invalid');
      setDetail(describe(cause));
    }
  }

  return (
    <section className="gate">
      <h1>Staff access</h1>
      <p>
        This area lists customers, their orders and every decision, so it is closed to anonymous
        callers. Paste the token you minted with{' '}
        <code>pnpm --filter @refund/api token --agent you --role admin</code>.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="staff-token">Staff token</label>
        <input
          id="staff-token"
          name="staff-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder="payload.signature"
          onChange={(event) => {
            setDraft(event.target.value);
            setStatus('idle');
          }}
        />
        <button type="submit" disabled={draft.trim().length === 0 || status === 'checking'}>
          {status === 'checking' ? 'Checking…' : 'Sign in'}
        </button>
      </form>
      {status === 'invalid' && (
        <p className="gate-error" role="alert">
          {detail}
        </p>
      )}
      {status === 'valid' && <p className="gate-ok">Signed in · {detail}</p>}
      <p className="gate-note">
        Tokens expire and live in this tab only. Every outstanding token is invalidated at once by
        restarting the server with a different <code>ADMIN_API_SECRET</code>.
      </p>
    </section>
  );
}
