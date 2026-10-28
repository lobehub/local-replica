import { useEffect, useLayoutEffect, useRef } from 'react';

import type { ReplicaEngine } from '../core/engine/createReplicaEngine';
import { replicaKeys } from '../core/resource/queryKeys';
import type { ReplicaResource } from '../core/resource/types';
import type { ReplicaSyncDriver } from './driver';
import type { ReplicaLens } from './lens';
import { replicaRequestId, type ReplicaRequests } from './requests';
import type { ReplicaSyncOptions, ReplicaSyncResult } from './types';

export interface ReplicaUseSyncDeps<TStore, TParams, TData, TFetched> {
  driver: ReplicaSyncDriver;
  engine: Pick<
    ReplicaEngine<TParams, TData, TFetched>,
    'ensureScope' | 'fetcher' | 'hydrate' | 'retain'
  >;
  get: () => TStore;
  /** Row key of the head query each entry last asked for (see the slice's `headQuery`). */
  headQuery: Map<string, string>;
  requests: ReplicaRequests<TParams, TFetched>;
  resource: ReplicaResource<TParams, TData, TFetched>;
  view: ReplicaLens<TStore, TData>;
}

/**
 * Hydrates the persisted row once per scope/key/query, then lets the driver
 * fetch and revalidate the head. Read the data from the store.
 */
export const createUseSync = <TStore, TParams, TData, TFetched>({
  driver,
  engine: { ensureScope, fetcher, hydrate, retain },
  get,
  headQuery,
  requests,
  resource,
  view,
}: ReplicaUseSyncDeps<TStore, TParams, TData, TFetched>) => {
  /**
   * Entries (`scope` + key) whose one-shot hydration actually painted a
   * persisted row. The hydration query settles `true` on a cache miss too, so
   * a reactivated key may only replay `onHydrated` when its row really came from
   * storage — not off a provisional seed or another source that happens to sit
   * in the view.
   */
  const hydratedEntries = new Set<string>();
  const hydratedEntryId = (scope: string, key: string) => `${scope}\u0000${key}`;

  const useSync = (
    params: TParams | null | undefined,
    {
      enabled = true,
      onError,
      onHydrated,
      onSuccess,
      ...schedule
    }: ReplicaSyncOptions<TFetched, TData> = {},
  ): ReplicaSyncResult => {
    const scope = resource.scope.use();
    const key = params ? resource.key(params) : undefined;
    const active = enabled && !!params && key !== undefined;
    const queryKey = params ? resource.storageKey(params) : undefined;

    // Layout effect: runs before paint, so a scope switch never shows a frame
    // of the previous identity's data.
    useLayoutEffect(() => {
      if (active) ensureScope(scope);
    }, [active, scope]);

    // Remember the query this entry now asks for (see `headQuery`).
    useLayoutEffect(() => {
      if (active && key !== undefined && queryKey !== undefined) headQuery.set(key, queryKey);
    }, [active, key, queryKey]);

    // Pin the entry on screen against eviction (`persist.maxEntries`).
    useLayoutEffect(() => {
      if (active && key !== undefined && queryKey !== undefined) return retain(key, queryKey);
    }, [active, key, queryKey]);

    // The entry this hook currently asks for. A hydrate that resolves after the
    // hook moved to another key still fills its own cache entry (harmless), but
    // it must not replay `onHydrated`: those side effects act on the *current*
    // view, so they would re-adopt a superseded object (e.g. navigate g1 → g2
    // while g1's storage read is slow, then g1's hydrate resets the active group
    // back to g1's supervisor).
    const activeKey = useRef<string | undefined>(undefined);
    // The entry (scope + key) whose hydration side effects already ran in its
    // current activation. Reset on every key or scope change, so an entry that
    // comes back (g1 → g2 → g1, or scope A → B → A with the same key) gets them
    // replayed even though its `once` hydration is not re-run.
    const hydratedKey = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
      activeKey.current = active ? key : undefined;
      hydratedKey.current = undefined;
    }, [active, key, scope]);

    const hydration = driver.useQuery<boolean>(
      active && resource.persisted && resource.persistKey(key!)
        ? replicaKeys.hydrate(resource.name, resource.version, scope, resource.storageKey(params!))
        : null,
      async () => {
        const didHydrate = await hydrate(params!, scope);
        if (didHydrate) hydratedEntries.add(hydratedEntryId(scope, key!));
        // A superseded key (the hook moved on) runs no side effects at all.
        if (activeKey.current !== key) return true;
        hydratedKey.current = hydratedEntryId(scope, key!);
        // A persisted row is a successful value with no network response: replay
        // the success side effects off it, so an offline / slow first paint still
        // adopts the roster and settles the flags the response path would.
        if (didHydrate) {
          const hydrated = view.get(get(), key!);
          if (hydrated !== undefined) onHydrated?.(hydrated);
        }
        return true;
      },
      { once: true },
    );

    // Reactivating a key whose hydration already settled: the driver reuses the
    // `once` result and the fetcher above does not run, so replay the side
    // effects off the value in memory. Without it, returning to g1 offline
    // leaves them acting on g2 until a response lands (or forever, offline).
    useEffect(() => {
      if (!active || key === undefined || hydration.data !== true) return;
      const entry = hydratedEntryId(scope, key);
      if (hydratedKey.current === entry) return;
      hydratedKey.current = entry;
      const current = view.get(get(), key);
      if (current !== undefined) {
        // A lookup that missed storage hydrated nothing to replay.
        if (hydratedEntries.has(entry)) onHydrated?.(current);
        return;
      }
      // Back on a scope whose view `ensureScope` cleared (A → B → A): the cached
      // `once` result means the fetcher will not read storage again, so read it
      // here — otherwise a row still in A's partition stays off screen while
      // the network is slow or offline.
      void hydrate(params!, scope).then((didHydrate) => {
        if (!didHydrate) return;
        hydratedEntries.add(entry);
        if (activeKey.current !== key || resource.scope.get() !== scope) return;
        const hydrated = view.get(get(), key);
        if (hydrated !== undefined) onHydrated?.(hydrated);
      });
    }, [active, key, scope, hydration.data]);

    const syncKey = active && fetcher ? requests.syncKeyOf(params!, scope, key!) : null;
    // The sync this hook last asked for. A driver may report a request that was
    // in flight when the hook went inactive (SWR keeps the last non-null key and
    // runs the *latest* render's callbacks, whose `params` is now null), so a
    // callback settles against the sync it belongs to, not the current render.
    const lastSync = useRef<{ key: string; params: TParams; scope: string; syncKey: readonly unknown[] }>(
      undefined,
    );
    useLayoutEffect(() => {
      if (syncKey) lastSync.current = { key: key!, params: params!, scope, syncKey };
    });
    /** The request settling now: the one this sync id last started. */
    const takeRequest = (response: unknown) => {
      const sync = syncKey ? { key: key!, params: params!, scope, syncKey } : lastSync.current;
      // Never active: no request of this hook can be settling.
      if (!sync) return;
      return {
        key: sync.key,
        request: requests.takeSyncRequest(
          replicaRequestId(sync.scope, sync.syncKey),
          response,
          sync.params,
          sync.scope,
        ),
        scope: sync.scope,
      };
    };

    const sync = driver.useQuery<TFetched>(
      syncKey,
      () => requests.startSync(params!, scope),
      {
        ...schedule,
        // Always installed, so a failed request is settled (and its capture
        // dropped) even when the caller has no error side effects. A failure
        // of a query the entry has moved past (or of a request from before a
        // clear) never surfaces on the query now on screen; an off-scope one is
        // still forwarded with the captured key/scope (see `settle`).
        onError: (error: unknown) => {
          const taken = takeRequest(error);
          if (!taken) return;
          const settled = requests.settle(taken.request, { error });
          if (settled.current)
            onError?.(error, { isActive: settled.isActive, key: taken.key, scope: taken.scope });
        },
        onSuccess: (data) => {
          const taken = takeRequest(data);
          if (!taken) return;
          const settled = requests.settle(taken.request, { data });
          if (!settled.current || !settled.isActive) return;
          // A key the hook has moved past (g1 → g2 while g1's request is in
          // flight, or g1 → no key): the response still fills g1's own entry,
          // but this view's side effects would re-adopt g1 over the g2 view.
          if (activeKey.current !== taken.key) return;
          onSuccess?.(data);
        },
      },
    );

    return {
      error: sync.error,
      // A read with no key has nothing to hydrate, so it counts as hydrated: a
      // conditional consumer must not show "loading" for an absent id (the
      // former SWR disabled-key behaviour). A read that is disabled but *has* a
      // key still waits for its persisted row.
      isHydrated:
        key === undefined ||
        !resource.persisted ||
        !resource.persistKey(key) ||
        hydration.data === true,
      isValidating: sync.isValidating,
      revalidate: () => sync.mutate(),
    };
  };

  return useSync;
};
