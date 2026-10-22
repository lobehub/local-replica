/** Address of one persisted row: the resource's row key inside an identity scope. */
export interface ReplicaRowKey {
  queryKey: string;
  scope: string;
}

export interface ReplicaRow<T> {
  data: T;
  updatedAt: number;
}

/**
 * Where a replica keeps its rows between sessions (IndexedDB, localStorage …).
 * The server stays the durable source of truth, so `get` is best-effort: it
 * swallows its own I/O failures and reports a miss. Writes are not: `set` and
 * `remove` must reject when they did not land (see each method), so the
 * engine can retry them instead of treating a dropped row as persisted.
 */
export interface ReplicaStorage<T> {
  get: (key: ReplicaRowKey) => Promise<ReplicaRow<T> | undefined>;
  /**
   * Strict read for destructive passes: like `get`, but **rejects** when the
   * row could not be read (I/O error, unparsable value) instead of reporting a
   * miss. The engine reads its per-scope index (and every row it patches)
   * through it before `remove` / `clear` / an entity patch / an eviction, so an
   * unreadable index fails the pass rather than passing for an empty one.
   *
   * Optional only for compatibility: a storage without it still hydrates and
   * persists, but every destructive pass **fails** (`clear()` resolves `false`,
   * a removal stays unpurged and is retried, an entity guard is kept) because
   * the engine cannot tell a miss from a failed read through `get`.
   */
  getStrict?: (key: ReplicaRowKey) => Promise<ReplicaRow<T> | undefined>;
  /**
   * Delete a row. Must **reject** when the delete did not land (a closed
   * IndexedDB, a quota or security error): the engine keeps the row indexed
   * and the removal unpurged, so the next `remove` / `clear` retries it instead
   * of letting a row the user deleted hydrate again. A missing row is a success.
   */
  remove: (key: ReplicaRowKey) => Promise<void>;
  /**
   * Write a row. Should **reject** when the write did not land: the engine only
   * treats a row as holding a value after `set` resolved, so a rejected write is
   * retried by the next persist rather than skipped as redundant. A storage that
   * swallows failures still works, but a dropped write then survives until the
   * value changes or the next session.
   */
  set: (key: ReplicaRowKey, row: ReplicaRow<T>) => Promise<void>;
}
