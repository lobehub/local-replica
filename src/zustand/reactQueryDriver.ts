import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ReplicaQueryOptions, ReplicaSyncDriver, ReplicaSyncSchedule } from './driver';

/** The parts of a TanStack Query `Query` the driver reads. */
interface ReactQueryLikeQuery {
  fetch(options?: undefined, fetchOptions?: { cancelRefetch?: boolean }): Promise<unknown>;
  getObserversCount(): number;
  queryKey: readonly unknown[];
}

/** The parts of a TanStack Query `QueryClient` the driver calls. */
export interface ReactQueryLikeClient {
  getQueryCache(): {
    findAll(filters: { predicate: (query: ReactQueryLikeQuery) => boolean }): ReactQueryLikeQuery[];
  };
  setQueryData(queryKey: readonly unknown[], data: any): unknown;
}

/** TanStack Query's `useQuery` (v5). */
export type ReactQueryLikeHook = (options: any) => {
  data?: any;
  error: unknown;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

/** Query key of a sync with no key: never fetched, so it never shares data. */
const DISABLED_KEY = ['local-replica', 'disabled'] as const;

/**
 * Map the SWR-named schedule onto `useQuery` options. Only options the caller
 * set are passed, so the `QueryClient` defaults apply otherwise.
 * `focusThrottleInterval` has no TanStack equivalent and is ignored;
 * `isPaused` and `revalidateOnMount` gate `enabled` (see the hook).
 */
const toQueryOptions = (
  {
    dedupingInterval,
    refreshInterval,
    refreshWhenHidden,
    refreshWhenOffline,
    revalidateIfStale,
    revalidateOnFocus,
    revalidateOnReconnect,
  }: ReplicaSyncSchedule,
  once: boolean | undefined,
) => ({
  ...(dedupingInterval !== undefined && { staleTime: dedupingInterval }),
  ...(refreshInterval !== undefined && {
    refetchInterval:
      typeof refreshInterval === 'function'
        ? (query: { state: { data: unknown } }) => refreshInterval(query.state.data) || false
        : refreshInterval || false,
  }),
  ...(refreshWhenHidden !== undefined && { refetchIntervalInBackground: refreshWhenHidden }),
  ...(refreshWhenOffline && { networkMode: 'always' }),
  ...(revalidateIfStale !== undefined && { refetchOnMount: revalidateIfStale }),
  ...(revalidateOnFocus !== undefined && { refetchOnWindowFocus: revalidateOnFocus }),
  ...(revalidateOnReconnect !== undefined && { refetchOnReconnect: revalidateOnReconnect }),
  // Run once per key: the cached result stands until the query is collected.
  ...(once && {
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  }),
});

/**
 * Driver over TanStack Query (v5). Pass the app's `QueryClient` and `useQuery`.
 *
 * TanStack Query v5 has no `onSuccess` / `onError` on `useQuery`, so the driver
 * runs them from the query function, the way SWR does: only for the latest
 * request of a key, and only while the hook is mounted. An overtaken request
 * still settles on its own response (the slice does that); reporting it again
 * would pair it with the newer request.
 */
export const createReactQueryDriver = ({
  queryClient,
  useQuery,
}: {
  queryClient: ReactQueryLikeClient;
  useQuery: ReactQueryLikeHook;
}): ReplicaSyncDriver => {
  /** Id of the latest run per query key; an older run reports nothing. */
  const latestRun = new Map<string, number>();
  let runs = 0;

  /**
   * Hooks paused on each sync key. `isPaused` holds *every* request, so the two
   * explicit paths — `mutate` and this driver's `revalidate` — have to read it
   * too, and only a render knows the current value.
   */
  const pausedHooks = new Map<string, Set<number>>();
  let hooks = 0;

  /** Take or release one hook's hold on a key; a key is held while its set is not empty. */
  const holdPause = (pauseKey: string, hook: number, paused: boolean) => {
    const pausedSet = pausedHooks.get(pauseKey) ?? new Set<number>();
    if (paused) pausedSet.add(hook);
    else pausedSet.delete(hook);
    if (pausedSet.size > 0) pausedHooks.set(pauseKey, pausedSet);
    else pausedHooks.delete(pauseKey);
  };

  return {
    // Every mounted query whose key matches, also one `enabled` still holds back.
    // A request in flight is replaced, like SWR's `mutate`: it may predate a write.
    revalidate: (match) =>
      Promise.all(
        queryClient
          .getQueryCache()
          .findAll({
            predicate: (query) =>
              query.getObserversCount() > 0 &&
              match(query.queryKey) &&
              // A paused key is held, and this revalidate is one of the requests it holds.
              !pausedHooks.has(JSON.stringify(query.queryKey)),
          })
          .map((query) => query.fetch(undefined, { cancelRefetch: true }).catch(() => undefined)),
      ),
    seed: (key, data) => {
      queryClient.setQueryData(key, data);
    },
    useQuery: <T>(
      key: readonly unknown[] | null,
      fetcher: () => Promise<T>,
      { once, onError, onSuccess, ...schedule }: ReplicaQueryOptions<T>,
    ) => {
      // The latest render's callbacks, like SWR; cleared on unmount.
      const callbacks = useRef<Pick<ReplicaQueryOptions<T>, 'onError' | 'onSuccess'> | null>(
        null,
      );
      // The key this render shows. A request in flight keeps the key it started
      // with, so a hook that switched keys must not settle the newer one.
      const activeKey = useRef<string | null>(null);
      // Which hook this render is, and the key it registered its pause under, so
      // a key shared by several hooks stays paused while any one of them is.
      const hook = useRef(0);
      if (hook.current === 0) hook.current = ++hooks;
      // The key this hook currently holds a pause under, if any.
      const pausedIn = useRef<string | null>(null);
      const hash = JSON.stringify(key);
      const paused = key !== null && (schedule.isPaused?.() ?? false);
      useLayoutEffect(() => {
        callbacks.current = { onError, onSuccess };
        activeKey.current = hash;
        const previous = pausedIn.current;
        pausedIn.current = paused ? hash : null;
        // The hook switched keys: keep no hold on the one it left.
        if (previous !== null && previous !== hash) holdPause(previous, hook.current, false);
        holdPause(hash, hook.current, paused);
      });
      useEffect(
        () => () => {
          callbacks.current = null;
          activeKey.current = null;
          const previous = pausedIn.current;
          pausedIn.current = null;
          if (previous !== null) holdPause(previous, hook.current, false);
        },
        [],
      );
      // `revalidateOnMount: false` holds the first request until `mutate`.
      const [armed, setArmed] = useState(schedule.revalidateOnMount !== false);

      const result = useQuery({
        enabled: key !== null && armed && !schedule.isPaused?.(),
        queryFn: async () => {
          const run = ++runs;
          latestRun.set(hash, run);
          const report = () => {
            if (latestRun.get(hash) !== run) return undefined;
            latestRun.delete(hash);
            // The hook moved to another key while this ran: drop the result
            // rather than deliver it to the render that replaced it.
            if (activeKey.current !== hash) return undefined;
            return callbacks.current;
          };
          let data: T;
          try {
            data = await fetcher();
          } catch (error) {
            report()?.onError?.(error);
            throw error;
          }
          report()?.onSuccess?.(data);
          // TanStack Query rejects `undefined` data.
          return data === undefined ? null : data;
        },
        queryKey: key ?? DISABLED_KEY,
        ...toQueryOptions(schedule, once),
      });

      return {
        data: result.data,
        error: result.error ?? undefined,
        isValidating: result.isFetching,
        mutate: () => {
          setArmed(true);
          // No key: there is nothing to fetch, and a manual refetch would run the
          // disabled query's fetcher with the null params the caller passed.
          if (key === null) return Promise.resolve(result.data);
          // `isPaused` holds every request, this one included: arming is enough,
          // the next render without a pause runs it. TanStack lets a manual
          // refetch of a disabled query through, so this path must check too.
          if (schedule.isPaused?.()) return Promise.resolve(result.data);
          return result.refetch();
        },
      };
    },
  };
};
