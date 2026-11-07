import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { stableQueryKey } from '../core/resource/storageKey';
import type { ReplicaQueryOptions, ReplicaSyncDriver, ReplicaSyncSchedule } from './driver';

/** The parts of a TanStack Query `Query` the driver reads. */
interface ReactQueryLikeQuery {
  fetch(options?: undefined, fetchOptions?: { cancelRefetch?: boolean }): Promise<unknown>;
  getObserversCount(): number;
  queryKey: readonly unknown[];
  /** The query's state; `seed` reads the settlement the cache write published. */
  state: { dataUpdateCount?: number; dataUpdatedAt: number };
}

/** The parts of a TanStack Query `QueryClient` the driver calls. */
export interface ReactQueryLikeClient {
  /** The raw value the cache holds, before any `select` of an observer. */
  getQueryData(queryKey: readonly unknown[]): any;
  getQueryCache(): {
    findAll(filters: { predicate: (query: ReactQueryLikeQuery) => boolean }): ReactQueryLikeQuery[];
  };
  setQueryData(queryKey: readonly unknown[], data: any): unknown;
}

/** TanStack Query's `useQuery` (v5). */
export type ReactQueryLikeHook = (options: any) => {
  data?: any;
  /**
   * How many times the cached data changed. TanStack's settlement identity: it
   * increments per update, so two updates that land in the same millisecond
   * still get different values. Missing on older shapes — the driver falls back
   * to `dataUpdatedAt` then.
   */
  dataUpdateCount?: number;
  /** When the cached data last changed; `0` when the query holds none. */
  dataUpdatedAt?: number;
  error: unknown;
  /** How many times the cached failure changed; the error-side `dataUpdateCount`. */
  errorUpdateCount?: number;
  /** When the cached failure last changed; `0` when the query holds none. */
  errorUpdatedAt?: number;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

/** Query key of a sync with no key: never fetched, so it never shares data. */
const DISABLED_KEY = ['local-replica', 'disabled'] as const;

/**
 * What a replaced fetch left behind: where its replacement started, and the
 * settlement that replacement produced, once one has been judged by it.
 *
 * A bare start would outlive the request it describes and be applied to any
 * later settlement over the same key — including one from a fetch that started
 * after a drop, which it would then refuse as pre-drop data. The settlement it
 * claimed scopes the start to the one request the record is about.
 */
interface ReplacedFetch {
  /** The settlement this replacement produced, once a hook has judged one. */
  settledFor?: number;
  /** When the replacement started. */
  start: number;
}

/**
 * When a fetch over a key was replaced while it was in flight, per `QueryClient`.
 *
 * `cancelRefetch` cancels the running fetch and starts its replacement without
 * ever publishing an idle state, so `isFetching` stays true across the swap and
 * a hook's own stamp would keep the start of the request the replacement
 * supersedes. A response the replacement produces after a drop would then be
 * judged by the pre-drop start and refused. The replacement is a fresh start,
 * and it happens on the shared cache, so it is recorded where every driver over
 * the same client reads it.
 */
const replacedFetches = new WeakMap<ReactQueryLikeClient, Map<string, ReplacedFetch>>();

/** The replacement starts recorded for one client, created on first use. */
const replacedFetchesOf = (client: ReactQueryLikeClient) => {
  const existing = replacedFetches.get(client);
  if (existing) return existing;
  const created = new Map<string, ReplacedFetch>();
  replacedFetches.set(client, created);
  return created;
};

/**
 * Identity of a settlement: the update count when the hook reports one, the
 * update timestamp otherwise. The count is what separates two settlements that
 * land in the same millisecond — TanStack stamps both with one wall-clock value.
 */
const settlementId = (count?: number, at?: number) => count ?? at ?? 0;

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
   * Settlement id (`dataUpdateCount`, or `dataUpdatedAt` where the hook does not
   * expose one) of the result each key last reported off the cache, so a
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
   * Settlement id of the failure each key last reported off the cache, the
   * error-side twin of `deliveredData`: a sibling hook — in another driver over
   * the same `QueryClient` — still has to settle a failure whose `queryFn` only
   * the executing hook ran, and must settle it once.
   */
  const deliveredError = new Map<string, number>();

  /**
   * `dataUpdatedAt` of the settlement a `seed` published for each key, the
   * timestamp twin of the mark `seed` writes into `deliveredData`: the hook's
   * settlement identity falls back to the timestamp where it exposes no update
   * count, so the seed has to be recognised under either identity.
   */
  const seededAt = new Map<string, number>();

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
    seededAt.delete(keyHash);
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
              !pausedHooks.has(stableQueryKey(query.queryKey)),
          })
          .map((query) => {
            // A fetch already in flight is replaced by this one, and a replacement
            // is a new start: record it so a hook judging a later settlement reads
            // when the surviving request began, not when the first one did. It
            // speaks for the one settlement this fetch produces (see `requestStart`).
            replacedFetchesOf(queryClient).set(stableQueryKey(query.queryKey), {
              start: Date.now(),
            });
            return query.fetch(undefined, { cancelRefetch: true }).catch(() => undefined);
          }),
      ),
    // TanStack leaves the cache untouched when `setQueryData` receives
    // `undefined`, so an absent response would settle nothing and a hook on the
    // same key would keep the value it painted. Encode it like the query
    // function above, which stores `null` for the same reason.
    seed: (key, data) => {
      queryClient.setQueryData(key, data === undefined ? null : data);
      // The write publishes a settlement, but no query function ran for it: the
      // replica that called `seed` already applied this response itself. Mark it
      // delivered for this driver, or a hook showing the key folds it again and
      // the slice applies the same response twice, repeating its effects. Only
      // while the key is held: an unheld key's entry would outlive its activation
      // and suppress the replay a later mount needs.
      const keyHash = stableQueryKey(key);
      if (!activeKeyHooks.has(keyHash)) return;
      // The write above put this key in the cache, so the lookup cannot come up
      // empty; reading its state is what tells the watch which settlement the
      // write published, under both identities a hook may settle with.
      const [seeded] = queryClient
        .getQueryCache()
        .findAll({ predicate: (query) => stableQueryKey(query.queryKey) === keyHash });
      const { dataUpdateCount, dataUpdatedAt } = seeded.state;
      deliveredData.set(keyHash, settlementId(dataUpdateCount, dataUpdatedAt));
      seededAt.set(keyHash, dataUpdatedAt);
    },
    useQuery: <T>(
      key: readonly unknown[] | null,
      fetcher: () => Promise<T>,
      { once, onError, onSuccess, replayable, ...schedule }: ReplicaQueryOptions<T>,
    ) => {
      // The latest render's callbacks, like SWR; cleared on unmount.
      const callbacks = useRef<Pick<ReplicaQueryOptions<T>, 'onError' | 'onSuccess'> | null>(
        null,
      );
      // The key this render shows. A request in flight keeps the key it started
      // with, so a hook that switched keys must not settle the newer one.
      const activeKey = useRef<string | null>(null);
      /**
       * When the request this hook last saw leave started, `0` when none does.
       * A settlement's `dataUpdatedAt` records completion, so a request that
       * began before the replica dropped the entry and finished after it would
       * look newer than the drop; the start is what says whether the response
       * was computed on the pre-drop or the post-drop side of it.
       *
       * It belongs to the key the hook is showing, like the other refs reset
       * below: a hook that switches to a key already fetching would otherwise
       * compare that key's response against the start of the request it left,
       * which the drop can sit between, and refuse a valid post-drop response.
       */
      const requestStartedAt = useRef(0);
      // Which hook this render is, and the key it registered its pause under, so
      // a key shared by several hooks stays paused while any one of them is.
      const hook = useRef(0);
      if (hook.current === 0) hook.current = ++hooks;
      // The key this hook currently holds a pause under, if any.
      const pausedIn = useRef<string | null>(null);
      // One identity per key, whatever order its params were written in:
      // TanStack dedupes `{ id, page }` and `{ page, id }` into one query, so the
      // driver's maps have to see them as one key too, or the hook that reads
      // the sibling's settlement tracks it under a hash nobody else knows.
      const hash = stableQueryKey(key);
      /**
       * When the request behind a settlement over this key began: this hook's own
       * stamp, or a later replacement of that fetch. `cancelRefetch` swaps the
       * request without publishing an idle state, so the stamp alone would keep
       * the start of the request the replacement superseded and hold a valid
       * post-drop response back.
       *
       * A replacement record speaks for the settlement its fetch produces, and
       * stops there: a settlement after that one came from a fetch that started
       * later, and applying the remembered start to it would refuse a response
       * computed after its own drop.
       */
      const requestStart = (settlement: number) => {
        const replaced = replacedFetchesOf(queryClient).get(hash);
        if (!replaced) return requestStartedAt.current;
        // The record speaks for the settlement its own fetch produces: the first
        // one judged against it. A later settlement came from a fetch that
        // started afterwards, and applying the remembered start to it would
        // refuse a response computed after its own drop.
        if (replaced.settledFor !== undefined && replaced.settledFor !== settlement) {
          return requestStartedAt.current;
        }
        replaced.settledFor = settlement;
        return Math.max(requestStartedAt.current, replaced.start);
      };
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
          // The request in flight now is not the one the hook last watched
          // leave: the render below stamps this key's own start, so a shared
          // query already fetching is judged on its provenance, not its
          // predecessor's.
          requestStartedAt.current = 0;
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
      // Settlement id this hook last settled on (see the watch below).
      const seen = useRef(0);
      // Settlement id of the failure this hook last settled on, and whether its
      // own run already reported that failure from the query function.
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
            // This run ended in a failure, so it will never produce a success
            // settlement for the watch below to fold. Hand the ownership back:
            // a replica that then retries the shared key reports its success
            // through that watch, and claiming it as this run's own would leave
            // this view empty on a query that succeeded.
            // Only a run that still owns the key may do it: one the hook left
            // behind (it switched keys while this ran) must not clear the flag
            // the newer run set, or that run's success is folded twice.
            if (reported) ranOwnQuery.current = false;
            throw error;
          }
          const reported = report();
          // A run that ends in a success holds no failure of its own to deliver:
          // TanStack publishes no error settlement while it retries, so the flag
          // a failed attempt set would still be here when another replica's later
          // failure lands on this hook, which would consume it and skip its
          // `onError` along with the resource's error effects. Only a run that
          // still owns the key may clear it, or a run the hook left behind would
          // drop the flag the newer run set.
          if (reported) ownErrorReported.current = false;
          reported?.onSuccess?.(data);
          // TanStack Query rejects `undefined` data.
          return data === undefined ? null : data;
        },
        queryKey: key ?? DISABLED_KEY,
        ...toQueryOptions(schedule, once),
      });

      // When the request over this key started, as this hook saw it leave. A
      // shared query another replica fetched shows here too, and only that start
      // says which side of a drop a settlement was computed on — for a failure as
      // well as for a value, so both watches below read the same start and
      // neither clears it: the request is over once it settles, and the reset
      // after them is what closes its window.
      useLayoutEffect(() => {
        if (key === null) return;
        if (result.isFetching && requestStartedAt.current === 0) {
          requestStartedAt.current = Date.now();
        }
      });

      // A result this hook's own query function did not produce: a key shared
      // with another replica over the same `QueryClient` (TanStack dedupes the
      // fetch), or a cache still holding the value when this hook mounted. The
      // hook still has to settle it, or its view stays empty while the query
      // succeeded. The settlement's id identifies it, so re-renders of the same
      // one report nothing — and two settlements that share one millisecond are
      // still told apart, since the id is the update count where there is one.
      useLayoutEffect(() => {
        const dataAt = result.dataUpdatedAt ?? 0;
        const dataId = settlementId(result.dataUpdateCount, result.dataUpdatedAt);
        if (key === null) return;
        if (ranOwnQuery.current) {
          // The settlement this hook's own run produced: its callback already ran
          // from the query function. Record it so a sibling hook of the same key
          // does not fold the same result again, then hand the ownership back —
          // a settlement after this one came from another run (a replica that
          // refetched the shared key), and this hook has to settle on it itself.
          if (dataAt === 0 || dataId === seen.current) return;
          ranOwnQuery.current = false;
          seen.current = dataId;
          deliveredData.set(hash, dataId);
          return;
        }
        if (dataAt === 0 || dataId === seen.current || deliveredData.get(hash) === dataId) return;
        // The settlement `seed` published for a response this replica already
        // applied: folding it again would apply the same response twice.
        if (seededAt.get(hash) === dataAt) {
          seen.current = dataId;
          return;
        }
        // The replica dropped this entry after the value was cached (`remove`,
        // or a clear of its scope). The cache still holds it, but replaying it
        // would put the dropped entry back on screen; leave the view empty until
        // a real response lands.
        // A response whose request began before the entry was dropped holds
        // pre-drop data even though it completes after the drop, so the gate
        // reads the request's start rather than its completion.
        // When the request behind this settlement started; `0` when this hook
        // never saw it leave (it mounted on a cache that holds no settlement in
        // flight), which leaves the gate below on the settlement's own time.
        const startedAt = requestStart(dataId);
        const settledAt = startedAt > 0 && startedAt < dataAt ? startedAt : dataAt;
        if (replayable && !replayable(settledAt)) {
          // Let this settlement go: the replica dropped what it would put back.
          // Recording it keeps a later render from readmitting it once the
          // start of the request it came from is no longer at hand.
          seen.current = dataId;
          return;
        }
        seen.current = dataId;
        deliveredData.set(hash, dataId);
        // The query function hands TanStack `null` for an `undefined` response;
        // the callback gets what the fetcher returned.
        //
        // Read it off the cache, not off `result.data`: an observer applies its
        // `select` — including a default one set on this key — so the hook's
        // `data` is a transformed value, while the replica that ran the query
        // settled on the raw response. Handing the selected value over would
        // settle two replicas of one query on two different shapes.
        const cached = queryClient.getQueryData(key);
        const settled = cached === undefined ? result.data : cached;
        callbacks.current?.onSuccess?.((settled === null ? undefined : settled) as T);
      });

      // A failure this hook's own query function did not produce: TanStack
      // deduped the shared fetch to another replica's hook, so only that hook's
      // `onError` ran and this view would keep a settled failure unseen.
      // The failure's settlement id identifies it, so it is delivered once.
      useLayoutEffect(() => {
        if (key === null) return;
        // TanStack's success reducer clears `error` but keeps `errorUpdatedAt`,
        // so a nonzero timestamp alone does not identify a current failure: a
        // cache that failed once and then succeeded would replay `onError(null)`
        // to the next replica that mounts on it. Only a live error is a failure.
        const errorAt = result.errorUpdatedAt ?? 0;
        const errorId = settlementId(result.errorUpdateCount, result.errorUpdatedAt);
        if (errorAt === 0 || errorId === seenError.current || result.error == null) return;
        seenError.current = errorId;
        if (ownErrorReported.current) {
          // Its own run reported this failure from the query function already;
          // record it so a sibling hook of the same key does not fold it again.
          ownErrorReported.current = false;
          deliveredError.set(hash, errorId);
          return;
        }
        if (deliveredError.get(hash) === errorId) return;
        // The replica dropped this entry after the failure was cached (`remove`,
        // or a clear of its scope) — the failure twin of the gate above. A
        // request that began before the drop failed on the pre-drop side of it,
        // and delivering it would fold the failure into a generation that never
        // asked for it: stale recovery or purge effects would run after the
        // clear. Hold it back, and record it so a later render does not
        // readmit it once the start of its request is no longer at hand.
        const startedAt = requestStart(errorId);
        const settledAt = startedAt > 0 && startedAt < errorAt ? startedAt : errorAt;
        if (replayable && !replayable(settledAt)) return;
        deliveredError.set(hash, errorId);
        callbacks.current?.onError?.(result.error);
      });

      // The request that produced the settlement above is over: close the window
      // both watches read, after they have read it. A request still in flight
      // keeps its start for the settlement it has yet to produce.
      useLayoutEffect(() => {
        if (key === null) return;
        if (!result.isFetching && requestStartedAt.current !== 0) requestStartedAt.current = 0;
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
