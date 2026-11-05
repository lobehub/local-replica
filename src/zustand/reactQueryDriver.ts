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
  /** When the cached data last changed; `0` when the query holds none. */
  dataUpdatedAt?: number;
  error: unknown;
  /** When the cached failure last changed; `0` when the query holds none. */
  errorUpdatedAt?: number;
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
 *
 * A key can be shared: two replicas over one `QueryClient` dedupe to a single
 * query, and a hook can mount on a result still in the cache. A hook that did
 * not run the query function for the key it shows still settles on the cached
 * result, once per settlement and driver.
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

  /**
   * `dataUpdatedAt` of the result each key last reported off the cache, so a
   * re-render of the same settlement reports nothing, and so a sibling hook of
   * the same key does not fold the settlement that hook already reported.
   *
   * Scoped to one activation of the key: while any hook shows it. The last hook
   * to leave drops the entry — its destination was cleared with it (an unmount,
   * or a scope reset that emptied the view), so the next activation has to
   * replay the cached settlement instead of being deduped against a fold that
   * no longer exists on screen.
   */
  const deliveredData = new Map<string, number>();

  /**
   * `errorUpdatedAt` of the failure each key last reported off the cache, the
   * error-side twin of `deliveredData`: a sibling hook — in another driver over
   * the same `QueryClient` — still has to settle a failure whose `queryFn` only
   * the executing hook ran, and must settle it once.
   */
  const deliveredError = new Map<string, number>();

  /** Hooks currently showing each key; the last one to leave ends its activation. */
  const activeKeyHooks = new Map<string, Set<number>>();

  /** The hooks showing a key; an absent one shows none. */
  const keyHooksOf = (keyHash: string) => {
    const existing = activeKeyHooks.get(keyHash);
    if (existing) return existing;
    const created = new Set<number>();
    activeKeyHooks.set(keyHash, created);
    return created;
  };

  const joinKey = (keyHash: string, hook: number) => {
    keyHooksOf(keyHash).add(hook);
  };

  const leaveKey = (keyHash: string, hook: number) => {
    const keyHooks = keyHooksOf(keyHash);
    keyHooks.delete(hook);
    if (keyHooks.size > 0) return;
    activeKeyHooks.delete(keyHash);
    // Nothing shows this key any more: its delivery is neither on screen nor
    // pending, so a later activation starts from the cache again.
    deliveredData.delete(keyHash);
    deliveredError.delete(keyHash);
  };

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
      // One activation of the key per hook: the delivery memory it dedupes
      // against lives from this effect's setup to its cleanup, so a key that
      // comes back later is a new activation rather than a re-render of one
      // whose view is gone.
      useLayoutEffect(() => {
        joinKey(hash, hook.current);
        return () => leaveKey(hash, hook.current);
      }, [hash]);
      useLayoutEffect(() => {
        callbacks.current = { onError, onSuccess };
        // A different key: this hook has not run that key's query yet, so a
        // result cached under it is one it still has to settle (see the watch).
        if (activeKey.current !== hash) {
          ranOwnQuery.current = false;
          seen.current = 0;
          seenError.current = 0;
          ownErrorReported.current = false;
        }
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
      // `revalidateOnMount: false` holds the first request of the key this hook
      // mounted with, until `mutate`. The hold is per key, not per hook: a key
      // the hook switches to has never been requested by it, so it fetches like
      // any other mount, and the schedule's contract says so.
      const heldKey = useRef<string | null>(schedule.revalidateOnMount === false ? hash : null);
      // Re-render once `mutate` releases the hold (`heldKey` is a ref).
      const [, releaseMountHold] = useState(0);
      const armed = heldKey.current !== hash;
      /**
       * Whether this hook itself ran the query function for the settlement it
       * shows. Its own run reports that settlement from the query function; the
       * cache watch below is for results that arrived without it — a key another
       * replica already fetched over the shared `QueryClient`, or a value still
       * cached on mount. It is per settlement, not per mounted key: the watch
       * clears it once that settlement is folded, so a later result on the same
       * key is settled by this hook too. Reset when the hook switches keys.
       */
      const ranOwnQuery = useRef(false);
      // `dataUpdatedAt` this hook last settled on (see the watch below).
      const seen = useRef(0);
      // `errorUpdatedAt` this hook last settled on, and whether its own run
      // already reported that failure from the query function.
      const seenError = useRef(0);
      const ownErrorReported = useRef(false);

      const result = useQuery({
        enabled: key !== null && armed && !schedule.isPaused?.(),
        queryFn: async () => {
          const run = ++runs;
          ranOwnQuery.current = true;
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
            const reported = report();
            // Only a run that still owns the key reports; one it no longer owns
            // settles on its own response, so the failure is not this hook's.
            if (reported?.onError) {
              ownErrorReported.current = true;
              reported.onError(error);
            }
            throw error;
          }
          report()?.onSuccess?.(data);
          // TanStack Query rejects `undefined` data.
          return data === undefined ? null : data;
        },
        queryKey: key ?? DISABLED_KEY,
        ...toQueryOptions(schedule, once),
      });

      // A result this hook's own query function did not produce: a key shared
      // with another replica over the same `QueryClient` (TanStack dedupes the
      // fetch), or a cache still holding the value when this hook mounted. The
      // hook still has to settle it, or its view stays empty while the query
      // succeeded. `dataUpdatedAt` identifies the settlement, so re-renders of
      // the same one report nothing.
      useLayoutEffect(() => {
        const dataAt = result.dataUpdatedAt ?? 0;
        if (key === null) return;
        if (ranOwnQuery.current) {
          // The settlement this hook's own run produced: its callback already ran
          // from the query function. Record it so a sibling hook of the same key
          // does not fold the same result again, then hand the ownership back —
          // a settlement after this one came from another run (a replica that
          // refetched the shared key), and this hook has to settle on it itself.
          if (dataAt === 0 || dataAt === seen.current) return;
          ranOwnQuery.current = false;
          seen.current = dataAt;
          deliveredData.set(hash, dataAt);
          return;
        }
        if (dataAt === 0 || dataAt === seen.current || deliveredData.get(hash) === dataAt) return;
        seen.current = dataAt;
        deliveredData.set(hash, dataAt);
        // The query function hands TanStack `null` for an `undefined` response;
        // the callback gets what the fetcher returned.
        callbacks.current?.onSuccess?.((result.data === null ? undefined : result.data) as T);
      });

      // A failure this hook's own query function did not produce: TanStack
      // deduped the shared fetch to another replica's hook, so only that hook's
      // `onError` ran and this view would keep a settled failure unseen.
      // `errorUpdatedAt` identifies the failure, so it is delivered once.
      useLayoutEffect(() => {
        if (key === null) return;
        const errorAt = result.errorUpdatedAt ?? 0;
        if (errorAt === 0 || errorAt === seenError.current) return;
        seenError.current = errorAt;
        if (ownErrorReported.current) {
          // Its own run reported this failure from the query function already;
          // record it so a sibling hook of the same key does not fold it again.
          ownErrorReported.current = false;
          deliveredError.set(hash, errorAt);
          return;
        }
        if (deliveredError.get(hash) === errorAt) return;
        deliveredError.set(hash, errorAt);
        callbacks.current?.onError?.(result.error);
      });

      return {
        data: result.data,
        error: result.error ?? undefined,
        isValidating: result.isFetching,
        mutate: () => {
          heldKey.current = null;
          releaseMountHold((renders) => renders + 1);
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
