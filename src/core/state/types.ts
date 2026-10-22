/**
 * Where the confirmed value of an entry came from.
 * - `storage`: hydrated from the persisted projection (may be stale)
 * - `server`: confirmed by a network response
 * - `local`: written locally before any hydrate/replace landed
 * - `seed`: a provisional local row (e.g. a list row standing in for a detail so
 *   an object stays resolvable). Unlike `local` it is *not* authoritative: a
 *   persisted `storage` value may replace it on hydrate, and it never persists —
 *   so it cannot overwrite the detail it is only standing in for.
 */
export type ReplicaSource = 'local' | 'seed' | 'server' | 'storage';

export interface ReplicaPendingMutation<T> {
  apply: (data: T) => T;
  id: number;
  /**
   * Query the overlay was started under. An entry key can be reused for another
   * query (a navigation), and an overlay only ever describes the query that
   * created it — carrying it over would apply (and later persist) one query's
   * row inside another.
   */
  query?: string;
}

export interface ReplicaEntryMeta<T> {
  /**
   * Confirmed snapshot. Only kept while optimistic mutations are in flight —
   * otherwise the view itself is the confirmed value.
   */
  base?: T;
  /** Params of the last hydrate/replace — what `loadMore` pages with. */
  params?: unknown;
  pending: ReplicaPendingMutation<T>[];
  /** Stable query identity beyond the key (filters, page size). */
  query?: string;
  /**
   * Every write made while the entry is still a `seed`, in order — the seed
   * writes themselves and the confirmed writes made over them. A hydrate that
   * replaces the seed replays them onto the stored value: the seed's fresher
   * fields (a list row's renamed title) and a confirmed edit made before
   * storage answered both survive, instead of storage painting older values.
   */
  seedPatches?: ReplicaSeedPatch<T>[];
  source: ReplicaSource;
  updatedAt: number;
}

export interface ReplicaSeedPatch<T> {
  /**
   * Replayed onto the stored value, so a seed write must merge the fields it
   * owns into its input rather than ignore it (its first run sees `undefined`).
   */
  apply: (data: T | undefined) => T | undefined;
  persist: boolean;
  /** A provisional seed write: replayed, but never makes the result confirmed. */
  seed?: boolean;
  /**
   * Source of a seed write. A later seed of the same tag supersedes this one
   * (since the last confirmed write), so it must carry every field this one set.
   */
  tag?: string;
}

/** Bookkeeping slot a replica keeps inside its domain store. */
export interface ReplicaState<T> {
  entries: Record<string, ReplicaEntryMeta<T>>;
  /** The scope every entry in memory belongs to. */
  scope?: string;
}
