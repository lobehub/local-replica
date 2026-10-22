import { createEntityPropagation } from '../entity/propagation';
import { createPersistedRows } from '../persistence/persistedRows';
import { ReplicaWriteQueue } from '../persistence/writeQueue';
import { replicaStorageKey } from '../resource/storageKey';
import type { ReplicaResource } from '../resource/types';
import {
  type ReplicaAction,
  type ReplicaEffect,
  replicaReducer,
  type ReplicaViewWrite,
} from '../state/reducer';
import type { ReplicaSource, ReplicaState } from '../state/types';
import { createPagination } from './pagination';
import { createEntityRemovalGuards, createRemovalGuards } from './removalGuards';
import { createScopeClear } from './scopeClear';
import type {
  OptimisticMutationOptions,
  ReplicaEngineOptions,
  ReplicaHeadOutcome,
  ReplicaOptimisticToken,
} from './types';

/**
 * The replica engine: every transition of one resource, independent of any
 * UI framework or state library.
 *
 * It owns hydrate-if-empty, server replace, pagination, optimistic overlays
 * with commit/rollback, entity propagation, scope isolation and serialized
 * persistence. The host store keeps the rendered value (see
 * {@link ReplicaStorePort}); fetch scheduling (when to sync, dedupe, focus
 * revalidation) belongs to an adapter such as `local-replica/zustand`.
 */
export const createReplicaEngine = <TParams, TData, TFetched = TData>(
  resource: ReplicaResource<TParams, TData, TFetched>,
  options: ReplicaEngineOptions<TParams, TData, TFetched>,
) => {
  const { port } = options;
  const paging = resource.paging;
  const prefix = options.actionPrefix ?? resource.name;
  const writeQueue = resource.storage ? new ReplicaWriteQueue<TData>(resource.storage) : undefined;
  const fetcher = options.fetcher ?? resource.fetcher;
  let mutationSeq = 0;
  /** Keys with a `loadMore` request in flight (the only valid `isLoadingMore`). */
  const loadingMore = new Set<string>();

  // ---- removal guards (see `removalGuards.ts`) -----------------------------
  const { clearRemoved, isPurged, isRemoved, markPurged, markRemoved, removalGeneration } =
    createRemovalGuards();
  const entityGuards = createEntityRemovalGuards();

  const getSlot = port.getState;
  const storageKey = (key: string, query?: string) => ({
    queryKey: replicaStorageKey(key, query),
  });

  const toPersisted = (data: TData): TData | null | undefined => {
    const paged = pagination.toPersisted(data);
    return options.toPersisted ? options.toPersisted(paged) : paged;
  };

  // ---- persisted rows (see `persistence/persistedRows.ts`) -----------------
  const rows = createPersistedRows<TData>({
    commit: (keys, state) =>
      port.commit(
        keys.map((key) => ({ data: undefined, key })),
        state,
        `${prefix}/evict`,
      ),
    getSlot,
    isRemoved,
    loadingMore,
    resource,
    writeQueue,
  });
  const { deleteRows, removeStoredVariants, retain, touchStorageKey } = rows;

  // ---- resource-wide clear (see `scopeClear.ts`) ---------------------------
  const { clear, clearGeneration, clearScope, lastPurge } = createScopeClear<TData>({
    port,
    prefix,
    resource,
    rows,
    writeQueue,
  });

  const runEffects = (effects: ReplicaEffect<TData>[]) => {
    if (!writeQueue || effects.length === 0) return;
    // Until identity resolves the scope is a guess; never write into it.
    if (!resource.scope.canPersist()) return;
    for (const effect of effects) {
      if (!resource.persistKey(effect.key)) continue;
      const key = { ...storageKey(effect.key, effect.query), scope: effect.scope };
      if (effect.type === 'remove') {
        // A repeated removal for this key can be a real no-op (see `remove`) —
        // but only once the row delete actually landed. A storage that rejects
        // the delete (a closed IndexedDB, a quota error) must leave the key
        // unpurged, so the next terminal answer retries it instead of letting a
        // stale row survive to hydrate again.
        // Every query variant goes: a row persisted under other filters would
        // otherwise hydrate the removed entry once the guard is superseded.
        void removeStoredVariants(effect.scope, effect.key, key.queryKey).then((removed) => {
          if (removed) markPurged(effect.scope, effect.key);
        });
        continue;
      }
      const data = toPersisted(effect.data);
      if (data === undefined) continue;
      if (data === null) {
        // Server-confirmed absence: remove the prior projection rather than
        // leaving it to be hydrated as if the value were still current.
        void deleteRows(effect.scope, [key.queryKey]);
        continue;
      }
      rows.writeRow(effect.scope, key.queryKey, data);
    }
  };

  /** Read an entry as it will be once `writes` are applied (latest write wins). */
  const readThrough = (writes: ReplicaViewWrite<TData>[], key: string): TData | undefined => {
    for (let i = writes.length - 1; i >= 0; i--) {
      const write = writes[i];
      if ('type' in write) return undefined;
      if (write.key === key) return write.data;
    }
    return port.read(key);
  };

  const dispatch = (action: ReplicaAction<TData>): boolean => runActions([action]);

  /**
   * Fold one or more actions into a single host commit. A caller that seeds
   * many keys (a list refresh) must not clone the view and notify subscribers
   * once per key; every action is still reduced in order, and the accumulated
   * writes are applied as ONE host update. A batch is dropped whole when any
   * action belongs to another identity (see {@link dispatch}).
   */
  function runActions(actions: ReplicaAction<TData>[]): boolean {
    if (actions.length === 0) return false;
    const activeScope = resource.scope.get();
    // An action captured under another identity is stale — drop it.
    if (actions.some((action) => action.scope !== activeScope)) return false;

    for (const action of actions) {
      // Every removal path (explicit `remove`, a missing response, an entity that
      // takes its whole value with it) arms the hydration guard for this key.
      if (action.type === 'remove') markRemoved(action.scope, action.key);
      // A replacement that reaches the active scope supersedes an earlier
      // removal, so the key may hydrate again. A response captured under another
      // scope is dropped above and must NOT clear its guard: the removal still
      // stands for its own scope, whose row delete may be pending or may have failed.
      if (action.type === 'replace') clearRemoved(action.scope, action.key);
    }

    const initial = getSlot();
    let slot = initial;
    const writes: ReplicaViewWrite<TData>[] = [];
    const effects: ReplicaEffect<TData>[] = [];
    const read = (key: string) => readThrough(writes, key);
    if (slot.scope !== undefined && slot.scope !== activeScope) {
      // Memory moves to another identity; what we knew of its rows can go.
      rows.forgetScope(slot.scope);
      const reset = replicaReducer(slot, { scope: activeScope, type: 'resetScope' }, read);
      writes.push(...reset.writes);
      slot = reset.state;
    }

    let changed = false;
    for (const action of actions) {
      const transition = replicaReducer(slot, action, read);
      writes.push(...transition.writes);
      effects.push(...transition.effects);
      // The reducer returns the entry's state unchanged for a no-op.
      if (transition.state !== slot) {
        slot = transition.state;
        changed = true;
      }
    }

    if (!changed && writes.length === 0 && slot === initial) return false;
    port.commit(writes, slot, `${prefix}/${actions.length > 1 ? 'batch' : actions[0].type}`);
    runEffects(effects);
    return true;
  }

  /**
   * Drop memory owned by another identity as soon as a new scope is active —
   * even when the new scope has nothing persisted and its fetch is slow, the
   * previous user's / workspace's rows must not stay on screen.
   */
  const ensureScope = (scope: string) => {
    if (scope === resource.scope.get() && getSlot().scope !== scope)
      dispatch({ scope, type: 'resetScope' });
  };

  const getConfirmed = (key: string): TData | undefined => {
    const entry = getSlot().entries[key];
    return entry?.pending.length ? entry.base : port.read(key);
  };

  const hydrate = async (
    params: TParams,
    scope = resource.scope.get(),
    { overwrite = false }: { overwrite?: boolean } = {},
  ) => {
    if (!resource.storage) return false;
    // An identity-less runtime reads network-only: its scope is a guess, so
    // hydrating it could paint another session's private rows.
    if (resource.scope.canHydrate && !resource.scope.canHydrate()) return false;
    const key = resource.key(params);
    if (!resource.persistKey(key)) return false;
    // A removed entry is not read back: only a later server value supersedes
    // the removal (see `replace`), so a stale row can never repaint it.
    if (isRemoved(scope, key)) return false;
    // Pending until settled: entity guards outlive every read that may hold them.
    const settle = entityGuards.startHydrate(scope);
    try {
      return await readAndHydrate(params, key, scope, overwrite);
    } finally {
      settle();
    }
  };

  const readAndHydrate = async (
    params: TParams,
    key: string,
    scope: string,
    overwrite: boolean,
  ) => {
    const storage = resource.storage!;
    // A read started before a `clear()` of this scope holds a wiped row.
    const generation = clearGeneration(scope);
    // After a `clear()`, read only once its row deletes landed.
    const purge = lastPurge(scope);
    if (purge && !(await purge)) return false;
    const query = resource.query(params);
    const { queryKey } = storageKey(key, query);
    const writesBefore = rows.writeCount();
    const cached = await storage.get({ queryKey, scope });
    if (!cached) return false;
    // Re-check after the read: a removal or a clear that landed while it was in
    // flight must not resurrect the row it just dropped.
    if (isRemoved(scope, key) || clearGeneration(scope) !== generation) return false;
    // The row holds what was read, unless a write was queued while reading.
    rows.rememberRead(scope, queryKey, cached.data, writesBefore);
    if (options.isHydratable && !options.isHydratable(cached.data, params)) return false;
    // Entities deleted while the read was in flight may still be in the row.
    const stored = withoutRemovedEntities(scope, cached.data);
    if (stored === undefined) return false;
    const data = overwrite ? pagination.keepClientOnlyRows(stored, port.read(key), key) : stored;
    const applied = dispatch({
      data,
      key,
      overwrite,
      params,
      query,
      scope,
      type: 'hydrate',
      updatedAt: cached.updatedAt,
    });
    // A hydrated row is a used row (bounded resources keep LRU order).
    if (applied && resource.scope.canPersist()) touchStorageKey(scope, queryKey);
    return applied;
  };

  /** Non-paged: whether a (prepared) head response is a terminal absence (`isMissing`). */
  const isMissingHead = (incoming: TFetched): boolean => !paging && !!options.isMissing?.(incoming);

  /**
   * Fold a head response in and report what it was: dropped by `prepareHead`,
   * a terminal absence (`isMissing`, applied as a removal) or a replacement.
   * `changed` is whether the store moved. `replace` is the boolean shorthand;
   * the zustand slice's settle pipeline reads the outcome to pick its effects.
   */
  const applyHead = (
    params: TParams,
    fetched: TFetched,
    scope = resource.scope.get(),
  ): { changed: boolean; outcome: ReplicaHeadOutcome } => {
    const key = resource.key(params);
    const incoming = options.prepareHead
      ? options.prepareHead(fetched, port.read(key), params)
      : fetched;
    if (incoming === undefined) return { changed: false, outcome: 'dropped' };
    // A response that says the entry is gone clears it outright: the merge path
    // would keep — and re-persist — the confirmed value it is replacing. It also
    // arms the hydration guard, so a persisted read still in flight cannot bring
    // the dropped value back.
    if (isMissingHead(incoming)) {
      // Route through `remove` so a repeated "missing" is a no-op and a response
      // captured under another scope is dropped rather than applied here.
      return { changed: remove(key, scope), outcome: 'missing' };
    }
    const query = resource.query(params);
    const entry = getSlot().entries[key];
    // A different query (filters, sort) must not merge with loaded pages. A
    // view seeded without bookkeeping is compared by its `viewFields`.
    const reset = entry
      ? entry.query !== query
      : paging !== undefined && !pagination.viewMatchesFields(port.read(key), params);
    const applied = dispatch({
      data: (confirmed) =>
        paging
          ? pagination.mergeHead(key, incoming, confirmed, params, reset)
          : options.merge
            ? options.merge(incoming, confirmed, params)
            : (incoming as unknown as TData),
      key,
      params,
      query,
      scope,
      type: 'replace',
    });
    if (applied) forgetRestoredEntities(scope, getConfirmed(key));
    return { changed: applied, outcome: 'replaced' };
  };

  const replace = (params: TParams, fetched: TFetched, scope = resource.scope.get()) =>
    applyHead(params, fetched, scope).changed;

  /**
   * Confirmed local write: patches the view (and the base under any overlay).
   * Pass `source: 'seed'` for a provisional row (a list row standing in for a
   * detail): it is hydratable and never persisted, so the authoritative value it
   * stands in for is preserved (see `ReplicaSource`).
   */
  const update = (
    key: string,
    apply: (data: TData | undefined) => TData | undefined,
    {
      persist = true,
      seedTag,
      source,
    }: { persist?: boolean; seedTag?: string; source?: ReplicaSource } = {},
  ) =>
    dispatch({ apply, key, persist, scope: resource.scope.get(), seedTag, source, type: 'update' });

  /**
   * Confirmed local write to several keys as ONE host update — same per-key
   * semantics as {@link update}, but a whole list seeds in a single commit
   * instead of one per row (no repeated view cloning or subscriber churn).
   */
  const updateMany = (
    entries: { apply: (data: TData | undefined) => TData | undefined; key: string }[],
    {
      persist = true,
      seedTag,
      source,
    }: { persist?: boolean; seedTag?: string; source?: ReplicaSource } = {},
  ) => {
    const scope = resource.scope.get();
    return runActions(
      entries.map(({ apply, key }) => ({
        apply,
        key,
        persist,
        scope,
        seedTag,
        source,
        type: 'update' as const,
      })),
    );
  };

  /**
   * Purge a removal that belongs to a scope which is no longer active.
   *
   * The in-memory view is not ours to touch — the active scope owns it — but the
   * guard and the persisted row both belong to THAT scope. Arming the one and
   * deleting the other keeps a switch back from hydrating a value the server
   * just deleted or denied. `dispatch` would reject the off-scope action
   * outright (see `replace`'s stale-scope guard), so the row would otherwise
   * survive untouched.
   *
   * Like `remove`, the delete only counts as done once it was actually queued:
   * an untrusted scope refuses writes, so the guard stays armed as `unpurged`
   * and a later removal retries instead of reporting a no-op that never deletes.
   */
  const purge = (key: string, scope: string): boolean => {
    if (isRemoved(scope, key) && isPurged(scope, key)) return false;
    markRemoved(scope, key);
    // Nothing persisted (no storage, or a key this resource never persists) is
    // already "cleared": the guard alone is the whole purge.
    if (!writeQueue || !resource.persistKey(key)) {
      markPurged(scope, key);
      return false;
    }
    if (!resource.scope.canPersist()) return false;
    void removeStoredVariants(scope, key, storageKey(key).queryKey).then((removed) => {
      if (removed) markPurged(scope, key);
    });
    return true;
  };

  /**
   * Drop an entry and its persisted row.
   *
   * A removal is a no-op only once there is genuinely nothing left to do: the
   * key is guarded, its value is gone, AND its stale row was already scheduled
   * for deletion (or there is no persisted row to clear). A subject with no
   * acceptance polls `null` every couple of seconds, and re-emitting the same
   * delete on every tick would only churn storage. But a removal whose delete
   * was skipped — an untrusted scope refuses writes — keeps retrying, so the row
   * cannot survive to hydrate again once the scope is trusted.
   *
   * A removal captured under another identity (a late NOT_FOUND arriving after a
   * workspace switch) is routed to {@link purge}: it must not touch the scope on
   * screen, yet its own scope's row still has to go.
   */
  const remove = (key: string, scope: string = resource.scope.get()): boolean => {
    if (scope !== resource.scope.get()) return purge(key, scope);
    // Nothing persisted (no storage, or a key this resource never persists) is
    // already "cleared"; otherwise the row delete must have been queued.
    const rowCleared = !writeQueue || !resource.persistKey(key) || isPurged(scope, key);
    if (rowCleared && isRemoved(scope, key) && port.read(key) === undefined) return false;
    return dispatch({ key, scope, type: 'remove' });
  };

  /**
   * Persist the confirmed value of an entry as it is now — the flush after a
   * burst of in-memory `update(..., { persist: false })` writes (a stream).
   */
  const persist = (key: string) => {
    const scope = resource.scope.get();
    if (getSlot().scope !== undefined && getSlot().scope !== scope) return;
    const data = getConfirmed(key);
    if (data === undefined) return;
    runEffects([{ data, key, query: getSlot().entries[key]?.query, scope, type: 'persist' }]);
  };

  const revalidate = (key?: string): Promise<unknown> =>
    options.revalidate ? options.revalidate(key) : Promise.resolve();

  /**
   * Start an optimistic overlay now and settle it later (multi-resource flows).
   * `query` tags the overlay with the query it describes; a caller that knows
   * the requested query (e.g. before the first page painted) should pass it, so
   * the overlay is scoped to that query rather than kept across every change.
   */
  const beginOptimistic = (
    key: string,
    apply: (data: TData) => TData,
    query?: string,
  ): ReplicaOptimisticToken<TData> => {
    const scope = resource.scope.get();
    const id = ++mutationSeq;
    // Tag the overlay with the query it describes: the entry may move on to
    // another query (or another query may reuse the key) before it settles.
    dispatch({
      apply,
      id,
      key,
      query: query ?? getSlot().entries[key]?.query,
      scope,
      type: 'optimistic',
    });
    return {
      commit: (confirm) => {
        dispatch({ confirm, id, key, scope, type: 'commit' });
      },
      rollback: () => {
        dispatch({ id, key, scope, type: 'rollback' });
      },
    };
  };

  /**
   * Apply `apply` to the view right away, run `serverCall`, then commit (the
   * confirmed value is persisted) or roll back (the view is rebuilt from the
   * confirmed base plus any other in-flight overlays) and rethrow.
   */
  const optimistic = async <TResult>(
    key: string,
    apply: (data: TData) => TData,
    serverCall: () => Promise<TResult>,
    mutationOptions: OptimisticMutationOptions<TData, TResult> = {},
  ): Promise<TResult> => {
    const token = beginOptimistic(key, apply);
    try {
      const result = await serverCall();
      token.commit(mutationOptions.confirm?.(result));
      return result;
    } catch (error) {
      token.rollback();
      throw error;
    } finally {
      if (mutationOptions.revalidate) void revalidate(key);
    }
  };

  // ---- pagination (see `pagination.ts`) -----------------------------------
  const pagination = createPagination<TParams, TData, TFetched>({
    fetcher,
    getSlot,
    loadingMore,
    options,
    port,
    resource,
    update,
  });
  const { collapse, insertHead, loadMore } = pagination;

  // ---- entity propagation (see `entity/propagation.ts`) --------------------
  const entities = createEntityPropagation<TData>({
    beginOptimistic,
    entity: options.entity,
    entityGuards,
    getSlot,
    paging,
    port,
    remove,
    resource,
    rows,
    update,
  });
  const {
    beginEntityOptimistic,
    entityKeys,
    forgetRestoredEntities,
    patchStoredEntity,
    removeEntity,
    updateEntity,
    withoutRemovedEntities,
  } = entities;
  const { patchStoredRows } = rows;

  return {
    applyHead,
    beginEntityOptimistic,
    beginOptimistic,
    clear,
    clearGeneration,
    clearScope,
    removalGeneration,
    collapse,
    dispatch,
    ensureScope,
    entityKeys,
    fetcher,
    getConfirmed,
    hydrate,
    insertHead,
    isMissingHead,
    loadMore,
    optimistic,
    patchStoredEntity,
    patchStoredRows,
    persist,
    remove,
    removeEntity,
    replace,
    resource,
    retain,
    revalidate,
    update,
    updateEntity,
    updateMany,
  };
};

export type ReplicaEngine<TParams, TData, TFetched = TData> = ReturnType<
  typeof createReplicaEngine<TParams, TData, TFetched>
>;
