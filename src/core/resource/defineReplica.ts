import type { ReplicaStorage } from '../../storage/types';
import type { ReplicaPagedData, ReplicaPageResult, ReplicaPagingConfig } from '../paging/types';
import { staticReplicaScope } from './scope';
import { replicaStorageKey, stableQueryKey } from './storageKey';
import type { ReplicaResource, ReplicaScope } from './types';

const DEFAULT_SCOPE = staticReplicaScope();

/** Builds the storage of one resource from its namespace (`replica:<name>:v<version>`). */
export type ReplicaStorageFactory<TData> = (namespace: string) => ReplicaStorage<TData> | undefined;

export interface DefineReplicaOptions<TParams, TData, TFetched = TData, TCursor = any> {
  /** Default network fetcher; a store binding may override it. */
  fetcher?: (params: TParams, cursor?: TCursor) => Promise<TFetched>;
  /** Entry identity inside one scope (memory bucket + persisted row). */
  key: (params: TParams) => string;
  name: string;
  paging?: ReplicaPagingConfig<any, TCursor>;
  /**
   * Bound what the resource keeps in storage. `maxEntries` caps the persisted
   * rows (storage keys: one per entry key and query) per scope; past it the
   * least recently used rows are evicted — their persisted row, index entry
   * and, when nothing holds it, their memory entry. Use rows (a hydrate or a
   * persist, including a skipped unchanged one) count as recent, and the order
   * lives in the persisted index, so it survives reloads. A row on screen (a
   * mounted `useSync`, see `retain`), with pending optimistic writes or a
   * `loadMore` in flight is never evicted. Unbounded by default.
   */
  persist?: { maxEntries?: number };
  /**
   * Entries that never touch storage (no hydrate, no persist) — e.g. scoped
   * buckets whose rows must not land under an ordinary entry. Defaults to all.
   */
  persistKey?: (key: string) => boolean;
  /**
   * Query identity beyond `key` (filters, sort, page size) — anything that
   * changes the rows without changing the key. Persisted rows are kept per
   * query, so a projection taken under other filters never hydrates; in memory
   * a query change resets loaded pages.
   */
  query?: (params: TParams) => unknown;
  /** Identity partition of memory and persisted rows. Defaults to one static scope. */
  scope?: ReplicaScope;
  /** Persisted copy of the replica. Omit for a memory-only replica (no first-frame paint). */
  storage?: ReplicaStorage<TData> | ReplicaStorageFactory<TData>;
  /**
   * Query-cache key of the network sync, for a resource adopting an existing
   * key that other code already revalidates by. Defaults to `replicaKeys.sync`.
   * With a custom key, revalidate through that key — `slice.revalidate` only
   * matches default keys.
   */
  syncKey?: (params: TParams) => readonly unknown[];
  /** Bump to invalidate every persisted row written by older shapes. */
  version: number;
}

export const defineReplica = <TParams, TData, TFetched = TData, TCursor = any>(
  options: DefineReplicaOptions<TParams, TData, TFetched, TCursor>,
): ReplicaResource<TParams, TData, TFetched, TCursor> => {
  const namespace = `replica:${options.name}:v${options.version}`;
  const storage =
    typeof options.storage === 'function' ? options.storage(namespace) : options.storage;

  return {
    fetcher: options.fetcher,
    key: options.key,
    maxPersistedEntries: options.persist?.maxEntries,
    name: options.name,
    namespace,
    paging: options.paging,
    persistKey: options.persistKey ?? (() => true),
    persisted: !!storage,
    query: (params) => (options.query ? stableQueryKey(options.query(params)) : undefined),
    storageKey: (params) =>
      replicaStorageKey(
        options.key(params),
        options.query ? stableQueryKey(options.query(params)) : undefined,
      ),
    scope: options.scope ?? DEFAULT_SCOPE,
    syncKey: options.syncKey,
    storage,
    version: options.version,
  };
};

export interface DefinePagedReplicaOptions<TParams, TItem, TCursor> extends Omit<
  DefineReplicaOptions<
    TParams,
    ReplicaPagedData<TItem, TCursor>,
    ReplicaPageResult<TItem, TCursor>
  >,
  'fetcher' | 'paging' | 'storage'
> {
  /** `cursor` is `undefined` for the head page. */
  fetchPage?: (
    params: TParams,
    cursor: TCursor | undefined,
  ) => Promise<ReplicaPageResult<TItem, TCursor>>;
  paging: ReplicaPagingConfig<TItem, TCursor>;
  storage?: ReplicaStorage<any> | ReplicaStorageFactory<any>;
}

/**
 * A resource whose value is a paged list ({@link ReplicaPagedData}). The
 * store view type may extend the paged shape with domain fields.
 */
export const definePagedReplica = <
  TParams,
  TItem,
  TCursor = number,
  TData extends ReplicaPagedData<TItem, TCursor> = ReplicaPagedData<TItem, TCursor>,
>(
  options: DefinePagedReplicaOptions<TParams, TItem, TCursor>,
): ReplicaResource<TParams, TData, ReplicaPageResult<TItem, TCursor>, TCursor> =>
  defineReplica<TParams, TData, ReplicaPageResult<TItem, TCursor>, TCursor>({
    ...options,
    fetcher: options.fetchPage,
    storage: options.storage as ReplicaStorage<TData> | ReplicaStorageFactory<TData> | undefined,
  });
