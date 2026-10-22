import type { ReplicaPersistedRows } from '../persistence/persistedRows';
import type { ReplicaWriteQueue } from '../persistence/writeQueue';
import type { ReplicaResource } from '../resource/types';
import type { ReplicaStorePort } from './types';

export interface ReplicaScopeClearDeps<TData> {
  /** Devtools label prefix of host updates. */
  prefix: string;
  port: ReplicaStorePort<TData>;
  resource: ReplicaResource<any, TData, any>;
  rows: ReplicaPersistedRows<TData>;
  writeQueue: ReplicaWriteQueue<TData> | undefined;
}

/**
 * Resource-wide clear of one scope: memory, every persisted row and reads in
 * flight. A clear bumps the scope's generation so reads started before it are
 * dropped, and records its row purge so a later hydrate waits for it.
 */
export const createScopeClear = <TData>({
  port,
  prefix,
  resource,
  rows,
  writeQueue,
}: ReplicaScopeClearDeps<TData>) => {
  const { deleteRows, readIndex } = rows;

  /** Bumped by every `clear()` of a scope; reads started before it are stale. */
  const clearGenerations = new Map<string, number>();
  const clearGeneration = (scope: string) => clearGenerations.get(scope) ?? 0;
  /**
   * The persisted-row purge of the last `clear()` per scope: `true` once every
   * row delete landed. A hydrate waits for it, and refuses to read while the
   * purge failed (an untrusted scope, a storage error) so a wiped resource can
   * never paint a row that survived it.
   */
  const scopePurges = new Map<string, Promise<boolean>>();
  const lastPurge = (scope: string) => scopePurges.get(scope);

  /**
   * Wipe the resource in the active scope: every entry leaves memory in one
   * host commit, every persisted row (all keys, all query variants) and the
   * index are deleted, and reads already in flight are dropped — a hydrate
   * started before the clear never dispatches, and `useSync` discards head
   * responses whose request started before it. Requests started afterwards
   * apply normally. Resolves `true` once the persisted rows are gone.
   */
  const clear = (): Promise<boolean> => {
    const scope = resource.scope.get();
    clearGenerations.set(scope, clearGeneration(scope) + 1);
    port.commit([{ type: 'clear' }], { entries: {}, scope }, `${prefix}/clear`);
    rows.forgetScope(scope);
    const purge = purgeScope(scope);
    scopePurges.set(scope, purge);
    return purge;
  };

  /**
   * `clear()` for any scope, including one that is not active (a user who
   * switched away while their data was being deleted): every persisted row of
   * `scope` and its index go, and for the active scope memory is wiped too
   * (exactly `clear()`). An inactive scope's memory is not on screen and is
   * left alone. The row deletes go through the write queue, so they land after
   * any write this session already queued for that scope — a row (or index
   * entry) written just before is purged rather than landing after the purge.
   * A later hydrate of `scope` waits for the purge. Resolves `true` once the
   * persisted rows are gone.
   */
  const clearScope = (scope: string): Promise<boolean> => {
    if (scope === resource.scope.get()) return clear();
    clearGenerations.set(scope, clearGeneration(scope) + 1);
    const purge = purgeScope(scope);
    scopePurges.set(scope, purge);
    return purge;
  };

  /** Delete every persisted row of `scope` (see `clear`). */
  const purgeScope = async (scope: string): Promise<boolean> => {
    if (!writeQueue) return true;
    // Until identity resolves the scope is a guess; never write into it.
    if (!resource.scope.canPersist()) return false;
    // Rows this session knows about are queued now, ahead of any later write.
    const queued = deleteRows(scope, [...(rows.indexedKeys(scope) ?? [])]);
    let persisted: string[];
    try {
      persisted = await readIndex(scope);
    } catch {
      return false;
    }
    // Keys this session tracks are already queued above, or were written by a
    // newer response since the clear (their row is fresh): skip both.
    const known = rows.indexedKeys(scope);
    const stale = persisted.filter((queryKey) => !known?.has(queryKey));
    const [first, rest] = await Promise.all([queued, deleteRows(scope, stale)]);
    return first && rest;
  };

  return { clear, clearGeneration, clearScope, lastPurge };
};
