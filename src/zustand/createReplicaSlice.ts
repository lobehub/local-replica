import { createReplicaEngine } from '../core/engine/createReplicaEngine';
import { isReplicaSyncKey } from '../core/resource/queryKeys';
import type { ReplicaResource } from '../core/resource/types';
import type { ReplicaState } from '../core/state/types';
import { ReplicaScopeChangedError } from './errors';
import { applyLensWrites } from './lens';
import {
  createRequests,
  type ReplicaOutcome,
  type ReplicaRequest,
  type ReplicaSettled,
} from './requests';
import type {
  CreateReplicaSliceOptions,
  ReplicaFetchOptions,
  ReplicaFetchResult,
  ReplicaSettleContext,
} from './types';
import { createUseSync } from './useSync';

/**
 * Bind a replica to a domain Zustand store.
 *
 * The domain store stays the only UI source of truth: components read the
 * `view` location through their usual selectors. The engine owns every
 * transition of that location; this slice adds the Zustand port and a
 * `useSync` hook that only orchestrates fetching — data never flows through
 * its return value.
 */
export const createReplicaSlice = <TStore, TParams, TData, TFetched = TData>(
  resource: ReplicaResource<TParams, TData, TFetched>,
  {
    driver,
    effects,
    get,
    set,
    stateKey,
    view,
    ...options
  }: CreateReplicaSliceOptions<TStore, TParams, TData, TFetched>,
) => {
  const revalidate = (key?: string) =>
    driver.revalidate((queryKey) =>
      isReplicaSyncKey(queryKey, resource.name, { key, scope: resource.scope.get() }),
    );

  const engine = createReplicaEngine(resource, {
    ...options,
    port: {
      // One host update for the view writes and the bookkeeping slot together.
      commit: (writes, state, label) =>
        set(
          { ...applyLensWrites(view, get(), writes), [stateKey]: state } as Partial<TStore>,
          false,
          label,
        ),
      getState: () => get()[stateKey] as unknown as ReplicaState<TData>,
      keys: view.keys && (() => view.keys!(get())),
      read: (key) => view.get(get(), key),
    },
    revalidate,
  });
  const { applyHead, clearGeneration, fetcher, isMissingHead, removalGeneration } = engine;

  /**
   * Row key of the head query each entry last asked for. One entry backs a
   * single view, so a response that belongs to a query the entry has already
   * moved past must not repaint it — it would show a superseded query, and a
   * view gated on the current query would then wait forever. Making this an
   * invariant of the slice (not of one driver) keeps it true for drivers that
   * leave a request's own callback live after the query changed.
   */
  const headQuery = new Map<string, string>();

  // ---- one settle pipeline ---------------------------------------------
  // Every head response — a mounted `useSync`, or `fetch` with no view mounted
  // — is captured by `begin` when its request starts and folded in by `fold`
  // when it settles (see `requests.ts`), so every path applies the same guards
  // and the same resource effects.

  const requests = createRequests<TParams, TFetched>({
    clearGeneration,
    fetcher,
    fold: (request, outcome) => fold(request, outcome),
    removalGeneration,
    resource,
  });

  /**
   * Whether the request still answers the query its entry shows. A `useSync`
   * request must match the query the entry last asked for (see `headQuery`). A
   * `fetch` may also land with no view mounted, but never over a view that
   * shows another query of the key.
   */
  const isActiveQuery = ({ key, queryKey, source }: ReplicaRequest<TParams, TFetched>) => {
    const head = headQuery.get(key);
    return source === 'sync' ? head === queryKey : head === undefined || head === queryKey;
  };

  /**
   * Fold a settled head request into the replica: apply every guard, then
   * `replace` / remove a terminal absence (in the captured scope) / purge one
   * captured off-scope, then run the resource effects.
   */
  const fold = (
    request: ReplicaRequest<TParams, TFetched>,
    outcome: ReplicaOutcome<TFetched>,
  ): ReplicaSettled => {
    const { key, params, scope } = request;
    /**
     * Whether the entry is still on the scope the request was captured under.
     *
     * A response can settle after an identity/workspace switch. `replace` drops
     * it — the engine refuses off-scope actions — but no side effect may run
     * either: it carries the previous identity's state (onboarding redirect,
     * display snapshot, analytics identify, settings writes). The captured
     * key/scope is not enough on its own, because a switch to a scope that
     * reads the same key/query satisfies the other guards.
     */
    const isActive = resource.scope.get() === scope;
    const dropped: ReplicaSettled = { applied: false, current: false, isActive, missing: false };
    const context: ReplicaSettleContext = { key, scope, source: request.source };

    // Discard a response that started before a `clear()` of its scope or a
    // `remove` of its entry (it holds wiped data), one for a query the entry
    // has moved past (the newer query owns the view, see `headQuery`), and one
    // older than a response already applied or a `fresh` fetch.
    const discarded =
      request.clearGeneration !== clearGeneration(scope) ||
      request.removalGeneration !== removalGeneration(scope, key) ||
      requests.isRetired(request) ||
      !isActiveQuery(request);

    // Every successful response settles the request — discarded, off-scope or
    // dropped by `prepareHead` below — so per-request bookkeeping is released.
    if (!('error' in outcome)) effects?.onSettled?.(outcome.data, params, context);
    if (discarded) return dropped;

    if ('error' in outcome) {
      // Forwarded even off-scope: the captured `key`/`scope` lets a consumer
      // purge that scope's row (a late NOT_FOUND / FORBIDDEN) without touching
      // the scope on screen; `isActive` tells it whether the failure also
      // belongs to the view on screen.
      effects?.onError?.(outcome.error, params, { isActive, key, scope });
      return { ...dropped, current: true };
    }

    if (!isActive) {
      // Off-scope: never fold a value into the scope on screen. A terminal
      // absence still purges its own scope's row (`remove` routes it there), so
      // a switch back cannot hydrate a value the server no longer has.
      const missing = isMissingHead(outcome.data);
      if (missing) {
        remove(key, scope);
        effects?.onPurge?.(params, context);
      }
      return { ...dropped, current: true, missing };
    }

    requests.retire(request.requestId, request.seq - 1);
    const { outcome: folded } = applyHead(params, outcome.data, scope);
    if (folded === 'replaced') effects?.onApplied?.(outcome.data, params, context);
    else if (folded === 'missing') effects?.onMissing?.(params, context);
    return {
      applied: folded !== 'dropped',
      current: true,
      isActive,
      missing: folded === 'missing',
    };
  };

  /**
   * Fetch the head of an entry now and settle it like a `useSync` response —
   * for stores that need the data while no view is mounted (a hover prefetch,
   * a refresh after a mutation on a route without the list). `revalidate` only
   * re-runs mounted queries.
   *
   * Joins a request in flight for the same entry unless `fresh`. Resolves with
   * what was fetched and whether it was applied; rejects when the request
   * fails, after routing the failure through `effects.onError`.
   */
  const fetch = async (
    params: TParams,
    { fresh = false, scope = resource.scope.get() }: ReplicaFetchOptions = {},
  ): Promise<ReplicaFetchResult<TFetched>> => {
    if (!fetcher) throw new Error(`[replica] ${resource.name} has no fetcher`);
    if (scope !== resource.scope.get()) throw new ReplicaScopeChangedError(resource.name, scope);
    let request = requests.begin(params, scope, 'fetch');
    const joined = fresh ? undefined : requests.inflight(request.requestId);
    if (joined) request = joined;
    else {
      if (fresh) requests.retire(request.requestId, request.seq - 1);
      requests.send(request);
    }

    let data: TFetched;
    try {
      data = await request.promise!;
    } catch (error) {
      requests.settle(request, { error });
      throw error;
    }
    const settled = requests.settle(request, { data });
    // Seed the driver's cache with what this fetch applied, unless a `useSync`
    // request of the key is in flight: it fills the cache itself, and a write
    // overtaking it could make the driver discard its newer response.
    if (
      settled.applied &&
      request.source === 'fetch' &&
      !requests.isSyncInflight(request.requestId)
    )
      driver.seed?.(request.syncKey, data);
    return { applied: settled.applied, data, missing: settled.missing };
  };

  /**
   * Forget the key's head query as well as the entry. A `useSync` request
   * already in flight for it would otherwise pass the settle guards (the
   * marker still matches), `replace` the entry and persist pre-mutation rows
   * back over an invalidation that has already completed. (The engine's
   * removal generation drops a `fetch` captured before the removal.)
   */
  const remove = (key: string, scope?: string) => {
    // Only the active scope's marker belongs to the entry on screen; an
    // off-scope removal (see `engine.remove`) must not drop it.
    if (scope === undefined || scope === resource.scope.get()) headQuery.delete(key);
    return engine.remove(key, scope);
  };

  const useSync = createUseSync<TStore, TParams, TData, TFetched>({
    driver,
    engine,
    get,
    headQuery,
    requests,
    resource,
    view,
  });

  return {
    ...engine,
    /** @internal Records of `useSync` requests not yet released (leak checks in tests). */
    debugPendingSyncRequests: requests.debugPendingSyncRequests,
    /** @internal Retirement records still held (leak checks in tests). */
    debugRetiredRequests: requests.debugRetiredRequests,
    fetch,
    remove,
    useSync,
  };
};

export type ReplicaSlice<TStore, TParams, TData, TFetched = TData> = ReturnType<
  typeof createReplicaSlice<TStore, TParams, TData, TFetched>
>;
