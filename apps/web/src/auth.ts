/**
 * Staff session storage.
 *
 * There is no login form that exchanges a password for a token, and there is no
 * token endpoint - adding one would let any anonymous caller mint themselves an
 * admin credential, which is a worse problem than the one it solves. An
 * operator pastes the token they minted with the CLI, exactly the way a
 * password manager shows an API key once and never stores it anywhere central.
 *
 * `sessionStorage` rather than `localStorage`: a staff token outlives nothing.
 * Closing the tab ends the session, and a token left in a shared machine's
 * persistent storage outlives the shift that was meant to use it.
 */

const STORAGE_KEY = 'refund-desk.staff-token';

let current: string | null = read();

const listeners = new Set<() => void>();

function read(): string | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    // Private browsing modes and non-browser test environments can throw on
    // storage access. An in-memory session is better than a crash.
    return null;
  }
}

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function staffToken(): string | null {
  return current;
}

export function setStaffToken(token: string): void {
  const trimmed = token.trim();
  current = trimmed.length > 0 ? trimmed : null;
  try {
    if (current === null) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, current);
    }
  } catch {
    // Keep the in-memory token even if persistence failed; the session works,
    // it just will not survive a reload.
  }
  emit();
}

export function clearStaffToken(): void {
  setStaffToken('');
}

export function hasStaffToken(): boolean {
  return current !== null;
}

/** Subscribes to session changes. Returns the unsubscribe function. */
export function onStaffTokenChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The header block for an authenticated call, empty when signed out. */
export function authHeaders(): Record<string, string> {
  return current === null ? {} : { authorization: `Bearer ${current}` };
}
