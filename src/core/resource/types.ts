import type { ReplicaStorage } from '../../storage/types';
import type { ReplicaPagingConfig } from '../paging/types';

/**
 * Identity partition of the persisted projection (user + workspace by default).
 * `use` feeds the sync hook, `get` imperative actions, `canPersist` gates writes
 * while the scope is still an optimistic guess (identity not resolved yet).
 */
export interface ReplicaScope {
  /**
   * Whether this runtime may read the persisted projection back into memory.
   * Defaults to `true`. A surface that never resolves an identity (e.g. a
   * public embed that does not mount the user store) opts out: its scope is
   * only the last-known guess, so hydrating it could paint a different — or a
   * since-invalidated — session's private rows before authorization is checked.
   */
  canHydrate?: () => boolean;
  canPersist: () => boolean;
  get: () => string;
  use: () => string;
}

export interface ReplicaResource<TParams, TData, TFetched = TData, TCursor = any> {
  /** Paged resources receive the page cursor (`undefined` = head page). */
  fetcher?: (params: TParams, cursor?: TCursor) => Promise<TFetched>;
  key: (params: TParams) => string;
  /** Cap of persisted rows per scope (LRU eviction, see `DefineReplicaOptions.persist`). */
  maxPersistedEntries?: number;
  name: string;
  /** Storage namespace — `name` + `version`, so a version bump orphans old rows. */
  namespace: string;
  /** Present on paged resources (`definePagedReplica`). */
  paging?: ReplicaPagingConfig<any, TCursor>;
  /** Whether the resource survives a reload (it has a storage). */
  persisted: boolean;
  /** Whether an entry key may be hydrated and persisted (see `persistKey`). */
  persistKey: (key: string) => boolean;
  /**
   * Query identity beyond `key` (filters, page size). Persisted rows are
   * stored per query, so a different query never hydrates; in memory a query
   * change resets loaded pages.
   */
  query: (params: TParams) => string | undefined;
  scope: ReplicaScope;
  storage?: ReplicaStorage<TData>;
  /** Row key in `storage` for these params (`key`, plus `?query` when set). */
  storageKey: (params: TParams) => string;
  /** Custom query-cache key of the network sync (see `DefineReplicaOptions.syncKey`). */
  syncKey?: (params: TParams) => readonly unknown[];
  version: number;
}
