import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { stableQueryKey } from '../core/resource/storageKey';
import type { ReplicaQueryOptions, ReplicaQueryResult, ReplicaSyncDriver } from './driver';
import { isDocumentHidden, isOffline, watchEnvironment } from './environment';

/** SWR's defaults, so a resource behaves the same on either driver. */
const DEDUPING_INTERVAL = 2000;
const FOCUS_THROTTLE_INTERVAL = 5000;

interface Snapshot {
  data?: unknown;
  error?: unknown;
  isValidating: boolean;
}

const IDLE: Snapshot = { isValidating: false };

const noop = () => undefined;

/** A mounted `useQuery` as the cache sees it: what to run, and whom to tell. */
interface Subscriber {
  /** The last non-null key the hook showed. Like SWR, a hook whose key turned null still hears its request. */
  key: string | null;
  mounted: boolean;
  options: ReplicaQueryOptions<any>;
}

/** One query key: its last result, the request in flight, the hooks showing it. */
interface Entry {
  /**
   * The fetcher of the latest committed render that showed this key. It lives on
   * the key, not on a hook: a hook's latest fetcher belongs to whatever key it
   * shows now, so a request of a key it left (a retained `mutate`, a revalidation
   * before the key change is committed) would fetch the new key and cache the
   * response under the old one.
   */
  fetcher?: () => Promise<unknown>;
  focusedAt: number;
  hasData: boolean;
  inflight?: Promise<unknown>;
  key: readonly unknown[];
  listeners: Set<() => void>;
  /** Id of the latest request; an older one settles nothing here. */
  run: number;
  snapshot: Snapshot;
  /** When the latest request started, for `dedupingInterval`. */
  startedAt: number;
  /** In mount order: the first one runs revalidations of the key. */
  subscribers: Set<Subscriber>;
}

const ownerOf = (entry: Entry) => entry.subscribers.values().next().value;

/**
 * The driver `createReplica` and `createReplicaSlice` use when none is passed:
 * a small query cache with no dependency, for apps that fetch with `useEffect`.
 * Each replica that is not given a driver creates its own.
 *
 * One instance may serve replicas of different resources, whose keys never
 * meet. It must not serve two replicas of the same resource: they would share
 * a key, dedupe to one request, and only the replica that started it would
 * settle the response into its store.
 *
 * It follows SWR's model and defaults: requests of a key dedupe within
 * `dedupingInterval` (2s), mounted keys revalidate on focus (throttled by
 * `focusThrottleInterval`, 5s) and on reconnect, `refreshInterval` polls, and
 * `isPaused` holds every request. A request reports to `onSuccess` / `onError`
 * of the hook that started it, and only while it is the latest of its key and
 * the hook still shows that key. It never reports a cached result, so it
 * ignores `replayable`. It does not retry a failed request: wrap the fetcher
 * for that.
 */
export const createDefaultDriver = (): ReplicaSyncDriver => {
  const entries = new Map<string, Entry>();

  const entryOf = (hash: string, key: readonly unknown[]) => {
    const existing = entries.get(hash);
    if (existing) return existing;
    const created: Entry = {
      focusedAt: 0,
      hasData: false,
      key,
      listeners: new Set(),
      run: 0,
      snapshot: IDLE,
      startedAt: 0,
      subscribers: new Set(),
    };
    entries.set(hash, created);
    return created;
  };

  const publish = (entry: Entry, patch: Partial<Snapshot>) => {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener();
  };

  /** Run the key's fetcher, or join the request a dedupe window covers; report to `subscriber`. */
  const start = (hash: string, entry: Entry, subscriber: Subscriber, dedupe: boolean) => {
    const { dedupingInterval = DEDUPING_INTERVAL, isPaused } = subscriber.options;
    // `isPaused` holds every request, the explicit ones included.
    if (isPaused?.()) return Promise.resolve(entry.snapshot.data);
    const now = Date.now();
    if (dedupe && entry.startedAt > 0 && now - entry.startedAt < dedupingInterval) {
      return entry.inflight ?? Promise.resolve(entry.snapshot.data);
    }
    const run = ++entry.run;
    entry.startedAt = now;
    const reports = () => subscriber.mounted && subscriber.key === hash;
    // Set by the layout effect of a render showing the key, which commits before
    // any request of it can start (mount, poll, focus, `revalidate`, `mutate`).
    const fetcher = entry.fetcher!;
    const promise = new Promise<unknown>((resolve) => resolve(fetcher())).then(
      (data) => {
        // A newer request owns the key; this one settles in the replica on its own.
        if (entry.run !== run) return data;
        entry.hasData = true;
        entry.inflight = undefined;
        publish(entry, { data, error: undefined, isValidating: false });
        if (reports()) subscriber.options.onSuccess?.(data);
        return data;
      },
      (error: unknown) => {
        if (entry.run === run) {
          entry.inflight = undefined;
          publish(entry, { error, isValidating: false });
          if (reports()) subscriber.options.onError?.(error);
        }
        throw error;
      },
    );
    entry.inflight = promise;
    publish(entry, { isValidating: true });
    return promise;
  };

  /** Revalidate every mounted key on a focus or reconnect, as its owner's schedule allows. */
  const revalidateOn = (signal: 'focus' | 'reconnect') => {
    const now = Date.now();
    for (const [hash, entry] of entries) {
      const owner = ownerOf(entry);
      if (!owner || owner.options.once) continue;
      const {
        focusThrottleInterval = FOCUS_THROTTLE_INTERVAL,
        revalidateOnFocus,
        revalidateOnReconnect,
      } = owner.options;
      if (signal === 'reconnect' ? revalidateOnReconnect === false : revalidateOnFocus === false) {
        continue;
      }
      if (signal === 'focus') {
        if (now - entry.focusedAt < focusThrottleInterval) continue;
        entry.focusedAt = now;
      }
      void start(hash, entry, owner, true).catch(noop);
    }
  };

  // Browser listeners while any hook is mounted.
  let mountedHooks = 0;
  let unwatch: () => void = noop;
  const attach = () => {
    if (mountedHooks++ === 0) {
      unwatch = watchEnvironment({
        onFocus: () => revalidateOn('focus'),
        onReconnect: () => revalidateOn('reconnect'),
      });
    }
  };
  const detach = () => {
    if (--mountedHooks === 0) unwatch();
  };

  return {
    // Every mounted key that matches, replacing a request in flight like SWR's
    // `mutate`: it may predate a write.
    revalidate: (match) =>
      Promise.all(
        [...entries].flatMap(([hash, entry]) => {
          const owner = ownerOf(entry);
          if (!owner || !match(entry.key)) return [];
          return [start(hash, entry, owner, false).catch(noop)];
        }),
      ),
    seed: (key, data) => {
      const entry = entryOf(stableQueryKey(key), key);
      entry.hasData = true;
      publish(entry, { data, error: undefined });
    },
    useQuery: <T>(
      key: readonly unknown[] | null,
      fetcher: () => Promise<T>,
      options: ReplicaQueryOptions<T>,
    ): ReplicaQueryResult<T> => {
      const hash = key === null ? null : stableQueryKey(key);
      const entry = hash === null ? null : entryOf(hash, key!);

      const subscriber = useRef<Subscriber>(null);
      subscriber.current ??= { key: hash, mounted: false, options };
      // The latest render's fetcher and callbacks, like SWR; the fetcher goes on the key it fetches.
      useLayoutEffect(() => {
        const current = subscriber.current!;
        current.options = options;
        if (hash === null) return;
        current.key = hash;
        entry!.fetcher = fetcher;
      });

      const subscribe = useCallback(
        (listener: () => void) => {
          if (!entry) return noop;
          entry.listeners.add(listener);
          return () => {
            entry.listeners.delete(listener);
          };
        },
        [entry],
      );
      const getSnapshot = () => entry?.snapshot ?? IDLE;
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

      // Show the key: fetch it as the schedule allows, and revalidate it while shown.
      const activated = useRef(false);
      // The key `revalidateOnMount: false` held at mount. Kept per key so React StrictMode's
      // replay of the same effect (same key, same mount) stays held, while a later key fetches.
      const heldKey = useRef<string | null>(null);
      useEffect(() => {
        if (hash === null || entry === null) return;
        // The hold belongs to the key the hook mounted with: a genuine key change releases
        // it, so coming back to that key fetches like any other later key.
        if (heldKey.current !== null && heldKey.current !== hash) heldKey.current = null;
        const current = subscriber.current!;
        current.mounted = true;
        entry.subscribers.add(current);
        attach();
        const { once, revalidateIfStale, revalidateOnMount } = current.options;
        const first = !activated.current;
        activated.current = true;
        const cached = entry.hasData && (once || revalidateIfStale === false);
        // Like SWR, `revalidateOnMount: false` only holds the first key a hook shows.
        const held = heldKey.current === hash || (first && revalidateOnMount === false);
        if (held) heldKey.current = hash;
        if (!cached && !held) void start(hash, entry, current, true).catch(noop);
        return () => {
          entry.subscribers.delete(current);
          detach();
        };
      }, [hash]);
      useEffect(
        () => () => {
          subscriber.current!.mounted = false;
        },
        [],
      );

      // Poll while shown. The interval is read on each tick, so it may change per render; its
      // value is a dependency too, so a schedule stopped at 0 turns back on when a function
      // interval starts returning a positive number (a fresh arrow identity would restart
      // the timer on every render instead).
      const { refreshInterval } = options;
      const polling =
        typeof refreshInterval === 'function'
          ? refreshInterval(entry?.snapshot.data as never)
          : refreshInterval;
      useEffect(() => {
        if (hash === null || entry === null || !polling) return;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;
        const schedule = () => {
          if (stopped) return;
          const { refreshInterval: interval, refreshWhenHidden, refreshWhenOffline } =
            subscriber.current!.options;
          const ms = typeof interval === 'function' ? interval(entry.snapshot.data) : interval;
          // A 0 interval stops the loop. The effect covers the option changing (the same
          // value drives its dependency), so this only guards a function interval that turns
          // 0 between the render that scheduled this tick and the tick itself.
          /* v8 ignore next -- unreachable while the option and its dependency agree */
          if (!ms) return;
          timer = setTimeout(() => {
            const allowed =
              (refreshWhenHidden || !isDocumentHidden()) && (refreshWhenOffline || !isOffline());
            // Never overlap the request this key already has in flight (the mount fetch or a
            // previous tick), and wait for the one this tick starts before scheduling the
            // next: a request slower than `refreshInterval` would otherwise be replaced
            // before it could report, leaving `isValidating` up and the callbacks swallowed.
            if (!allowed || entry.inflight) {
              schedule();
              return;
            }
            void start(hash, entry, subscriber.current!, true).catch(noop).then(schedule);
          }, ms);
        };
        schedule();
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, [hash, polling]);

      return {
        data: snapshot.data as T | undefined,
        error: snapshot.error,
        isValidating: snapshot.isValidating,
        // Settles even on a failure: the error is in the result, and `onError` heard it.
        mutate: () =>
          hash === null || entry === null
            ? Promise.resolve(undefined)
            : start(hash, entry, subscriber.current!, false).catch(noop),
      };
    },
  };
};
