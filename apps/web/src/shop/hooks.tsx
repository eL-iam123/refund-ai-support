import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { describe, shopApi, type ShopUser } from './api';

/**
 * Session state for the storefront.
 *
 * The token itself is never in JavaScript - it is httpOnly - so "signed in" is
 * a fact the server owns. This hook holds the user record the server hands back
 * and re-reads it on mount, which is why a sign-out in another tab shows up on
 * the next navigation instead of lingering.
 */
export interface SessionState {
  readonly user: ShopUser | null;
  readonly ready: boolean;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

export function useSession(): SessionState {
  const [user, setUser] = useState<ShopUser | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const { user: current } = await shopApi.me();
    setUser(current);
    setReady(true);
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await shopApi.logout();
    setUser(null);
  }, []);

  useEffect(() => {
    let live = true;
    // Nothing is set synchronously: with an unreachable API the storefront shows
    // signed-out rather than spinning forever, and the account page reports the
    // real problem.
    void shopApi
      .me()
      .then((result) => {
        if (live) {
          setUser(result.user);
          setReady(true);
        }
      })
      .catch(() => {
        if (live) {
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  return { user, ready, refresh, signOut };
}

/** Read-only page data, with the error surfaced instead of swallowed. */
export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    void load()
      .then((result) => {
        if (live) {
          setData(result);
          // Cleared on success rather than on the way in, so a reload does not
          // blank the previous error while the request is still in flight.
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setError(describe(cause));
        }
      });
    return () => {
      live = false;
    }
    // `load` is intentionally excluded: callers pass an inline closure, and
    // depending on its identity would re-fetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

export function useCart(): {
  lines: readonly CartLine[];
  add: (productId: string) => void;
  clear: () => void;
  count: number;
} {
  const [lines, setLines] = useState<readonly CartLine[]>([]);

  const add = useCallback((productId: string): void => {
    setLines((current) => {
      const existing = current.find((line) => line.productId === productId);
      if (existing === undefined) {
        return [...current, { productId, quantity: 1 }];
      }
      return current.map((line) =>
        line.productId === productId ? { ...line, quantity: Math.min(10, line.quantity + 1) } : line,
      );
    });
  }, []);

  const clear = useCallback((): void => setLines([]), []);

  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  return { lines, add, clear, count };
}

export function Spinner(): ReactNode {
  return <p className="muted">Loading…</p>;
}
