import { useEffect, useState } from 'react';
import { describe } from './api';

/**
 * The data-loading shape used by every page.
 *
 * Three decisions worth stating:
 *
 * 1. The effect body makes no synchronous setState. `loading` is the initial
 *    value, so a refetch does not cascade a render before the request starts.
 * 2. `load` must be a stable `useCallback`, and `key` must change whenever the
 *    data should be refetched. Both are in the dependency list deliberately.
 * 3. Requests are cancellable. Without the flag, a slow filter change could
 *    land after a fast one and overwrite it with stale rows.
 *
 * The stale check at the end derives the spinner during render instead of
 * setting state in the effect, so switching filters shows "loading" without an
 * intermediate flash of the previous filter's rows.
 */
export type Async<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ready'; readonly value: T };

interface Settled<T> {
  readonly key: string;
  readonly state: Async<T>;
}

export function useAsyncData<T>(load: () => Promise<T>, key: string): Async<T> {
  const [settled, setSettled] = useState<Settled<T>>({ key, state: { status: 'loading' } });

  useEffect(() => {
    let cancelled = false;
    void load().then(
      (value) => {
        if (!cancelled) {
          setSettled({ key, state: { status: 'ready', value } });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setSettled({ key, state: { status: 'error', error: describe(cause) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, key]);

  return settled.key === key ? settled.state : { status: 'loading' };
}
