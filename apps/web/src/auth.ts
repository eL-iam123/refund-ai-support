/**
 * Staff session state.
 *
 * The credential is a username and password exchanged for an httpOnly cookie
 * held by the browser. Nothing reusable is kept in JavaScript: there is no token
 * in `sessionStorage` and none in `localStorage`, because every store a token
 * can be read back out of is a store a cross-site-scripting bug can read it back
 * out of. `sameSite=lax` and `httpOnly` on the cookie mean the console session
 * survives the storefront having an XSS bug, which is the whole reason for
 * choosing a session over the pasted-token flow this replaces.
 *
 * This module holds only *who* is signed in, to render the layout. It is not
 * what authorises anything: the API checks the cookie itself on every call, so a
 * stale or wrong value here changes what the header shows and nothing else.
 */

export interface StaffSession {
  readonly username: string;
  readonly role: 'agent' | 'admin';
}

let current: StaffSession | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function staffSession(): StaffSession | null {
  return current;
}

export function setStaffSession(session: StaffSession | null): void {
  const changed = current?.username !== session?.username || current?.role !== session?.role;
  current = session;
  if (changed) {
    emit();
  }
}

export function isSignedIn(): boolean {
  return current !== null;
}

/** Subscribes to session changes. Returns the unsubscribe function. */
export function onStaffSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
