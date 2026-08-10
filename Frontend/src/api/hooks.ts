/**
 * Reading from the API in a component.
 *
 * WHY NOT REACT QUERY: this stage replaces a synchronous store with a network
 * one, and adding a cache library at the same moment would mean two new
 * behaviours to debug when a screen shows the wrong thing. What the migrated
 * screens actually need is "fetch this, tell me if it failed, let me refetch
 * after a write" — about forty lines. When the rest of the store follows and
 * the caching genuinely earns its keep, this is small enough to throw away.
 *
 * WHAT REPLACED WHAT: `useDatabase()` returned the whole object graph
 * synchronously and re-rendered every reader on any write. These hooks are the
 * async equivalent for one resource at a time, and a write refetches
 * explicitly rather than the world re-rendering. That is more typing per screen
 * and it is the point: it makes visible which screen depends on which data.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "./client.js";

export interface QueryState<T> {
  readonly data: T | undefined;
  /** True until the first response arrives. A refetch does NOT set this — a
   * list must not flash back to a spinner every time somebody edits a row. */
  readonly loading: boolean;
  readonly error: ApiError | null;
  readonly refetch: () => void;
}

/**
 * Fetch `path` and keep it until the dependencies change.
 *
 * `path` doubles as the cache key, which is why it must be the whole URL
 * including any query string: two screens asking for `/customers` and
 * `/customers?q=ravi` are asking different questions.
 *
 * Passing `null` skips the fetch entirely — for a request that depends on an
 * id the component does not have yet.
 */
export function useApiQuery<T>(path: string | null): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // Guards against a slow response for a path the component has since moved
  // off overwriting a fast response for the current one — open case A, click
  // straight to case B, and A's reply lands second.
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) {
      setData(undefined);
      setLoading(false);
      return;
    }

    const request = ++latest.current;
    let cancelled = false;
    setError(null);
    // Only the first load shows a spinner; a refetch leaves the old data on
    // screen until the new data replaces it.
    setLoading((current) => (data === undefined ? true : current));

    api<T>(path)
      .then((result) => {
        if (cancelled || request !== latest.current) return;
        setData(result);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled || request !== latest.current) return;
        setError(
          caught instanceof ApiError ? caught : new ApiError(0, "Something went wrong."),
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `data` is deliberately not a dependency: it is read only to decide
    // whether this is a first load, and including it would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, refetch };
}

/**
 * Run a write, and hand back whether it is in flight and how it was refused.
 *
 * Every migrated screen's mutation goes through this so that no screen invents
 * its own way of showing a server refusal. The refusal text is the SERVER's
 * words — "4 requirements still outstanding", "This case is on hold" — because
 * a message the user can act on beats a disabled button (the same principle
 * the prototype's own guards followed).
 */
export function useMutation(): {
  readonly run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  readonly pending: boolean;
  readonly error: string | null;
  readonly clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await work();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.",
      );
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}
