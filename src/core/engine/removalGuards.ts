import { createTombstones, DEFAULT_REMOVAL_TOMBSTONE_LIMIT } from './tombstones';

/**
 * Removal guard of one engine.
 *
 * An explicit removal (a deleted / unauthorized aggregate, or a subject whose
 * attachment is gone) drops the entry AND its persisted row — but a read of
 * that row that started before the removal still holds the old value, and a
 * removal leaves no trace in the slots for the `hydrate` guard to see. So a
 * scope+key is remembered as removed and refuses hydration until a server
 * value supersedes it, otherwise the late read resurrects the exact value the
 * removal just dropped.
 */
export const createRemovalGuards = () => {
  const removedEntries = createTombstones();
  /**
   * Keys whose persisted row delete was actually queued. `runEffects` refuses to
   * write while the scope is untrusted, so a removal made on a cold boot can arm
   * the guard without clearing the row. The guard alone must therefore not turn
   * a later removal into a no-op, or the stale row would survive and hydrate
   * again once the scope becomes trusted.
   */
  const purgedEntries = createTombstones();
  /**
   * Bumped on every removal of a scope+key, and stamped with when it happened.
   * A network response whose request started before the entry was removed
   * (deleted, access revoked, pruned by an authoritative parent list) must not
   * `replace` it back: the slice records the generation a request starts under
   * and drops a response that crossed a removal. The stamp answers the other
   * half of the same question — a value cached *before* the removal must not be
   * replayed to a later mount — see the engine's `droppedAt`.
   *
   * Bounded like the tombstones. An evicted key reads generation 0, which only
   * ever drops a response (the next revalidate refetches), never admits one.
   */
  const removalGenerations = new Map<string, { at: number; generation: number }>();
  /**
   * Stamp of the most recently evicted removal. A watermark miss cannot read 0
   * the way a generation miss can: 0 means "never removed", which is exactly the
   * answer that lets a value cached *before* an evicted removal replay to a later
   * mount and resurrect it. Entries are re-inserted on every removal and stamped
   * with a monotonic clock, so the evicted one always holds the oldest stamp —
   * using it as the floor for a miss only drops settlements that could predate
   * the eviction, and a dropped replay costs a fetch while an admitted one
   * restores the data the removal just dropped.
   */
  let evictedWatermark = 0;
  const removalId = (scope: string, key: string) => `${scope}\u0000${key}`;
  const removalGeneration = (scope: string, key: string) =>
    removalGenerations.get(removalId(scope, key))?.generation ?? 0;
  /** When `scope`/`key` was last removed, or the eviction floor if it never was. */
  const removalWatermark = (scope: string, key: string) =>
    removalGenerations.get(removalId(scope, key))?.at ?? evictedWatermark;
  const markRemoved = (scope: string, key: string) => {
    removedEntries.add(scope, key);
    const id = removalId(scope, key);
    const next = (removalGenerations.get(id)?.generation ?? 0) + 1;
    // Re-insert so the map's insertion order is least-recently-removed first.
    removalGenerations.delete(id);
    removalGenerations.set(id, { at: Date.now(), generation: next });
    if (removalGenerations.size > DEFAULT_REMOVAL_TOMBSTONE_LIMIT) {
      // `Map` iterates in insertion order, so the first key is the oldest stamp.
      const oldest = removalGenerations.keys().next().value as string;
      // Remember where the watermark left off before dropping its entry.
      evictedWatermark = Math.max(evictedWatermark, removalGenerations.get(oldest)!.at);
      removalGenerations.delete(oldest);
    }
  };
  const clearRemoved = (scope: string, key: string) => {
    removedEntries.clear(scope, key);
    purgedEntries.clear(scope, key);
  };
  const isRemoved = (scope: string, key: string) => removedEntries.has(scope, key);
  const markPurged = (scope: string, key: string) => purgedEntries.add(scope, key);
  const isPurged = (scope: string, key: string) => purgedEntries.has(scope, key);

  return {
    clearRemoved,
    isPurged,
    isRemoved,
    markPurged,
    markRemoved,
    removalGeneration,
    removalWatermark,
  };
};

export type ReplicaRemovalGuards = ReturnType<typeof createRemovalGuards>;

/**
 * Entity removal guards of one engine.
 *
 * A hydrate that read its row before `removeEntity` patched storage still
 * holds the entity, so it is stripped from every value that hydrates while
 * such a read may be pending. A guard's lifetime follows the hydrates, not a
 * count: it is released once its storage patch landed (`releasedAt`) and is
 * dropped as soon as no hydrate that started before that point is pending.
 * So memory stays bounded by in-flight reads, and no guard a pending read
 * still needs is ever evicted. A patch that did not land is never released:
 * the unloaded row still holds the entity, so every later hydrate needs the
 * guard. A server value holding the entity again (restored) lifts it early.
 */
export const createEntityRemovalGuards = () => {
  /** Logical clock shared by hydrate starts and guard releases. */
  let guardClock = 0;
  /** Start ticks of the hydrates in flight, per scope. */
  const pendingHydrates = new Map<string, Set<number>>();
  /** Removed entity ids per scope; `releasedAt` is unset until the storage patch landed. */
  const removedEntities = new Map<string, Map<string, { releasedAt?: number }>>();
  const removedIds = (scope: string) => [...(removedEntities.get(scope)?.keys() ?? [])];

  /** Drop the guards no pending hydrate of `scope` can still need. */
  const pruneEntityGuards = (scope: string) => {
    const guards = removedEntities.get(scope);
    if (!guards) return;
    let oldestPending = Infinity;
    for (const start of pendingHydrates.get(scope) ?? [])
      oldestPending = Math.min(oldestPending, start);
    for (const [id, guard] of guards)
      if (guard.releasedAt !== undefined && guard.releasedAt <= oldestPending) guards.delete(id);
    if (guards.size === 0) removedEntities.delete(scope);
  };

  /**
   * Mark a hydrate of `scope` pending until settled: entity guards outlive every
   * read that may hold them. Returns the settle.
   */
  const startHydrate = (scope: string) => {
    const start = ++guardClock;
    const pending = pendingHydrates.get(scope) ?? new Set<number>();
    pendingHydrates.set(scope, pending);
    pending.add(start);
    return () => {
      pending.delete(start);
      if (pending.size === 0) pendingHydrates.delete(scope);
      pruneEntityGuards(scope);
    };
  };

  /** Arm the guard of entity `id` in `scope`. Returns its release (call once the patch landed). */
  const guardEntity = (scope: string, id: string) => {
    const guard: { releasedAt?: number } = {};
    const guards = removedEntities.get(scope) ?? new Map<string, { releasedAt?: number }>();
    removedEntities.set(scope, guards);
    guards.set(id, guard);
    return () => {
      // A newer removal of the same id owns the slot now.
      if (guards.get(id) !== guard) return;
      guard.releasedAt = ++guardClock;
      pruneEntityGuards(scope);
    };
  };

  /** Lift the guards of `ids` early (a server value holds them again). */
  const liftEntityGuards = (scope: string, ids: string[]) => {
    const guards = removedEntities.get(scope);
    if (!guards) return;
    for (const id of ids) guards.delete(id);
    if (guards.size === 0) removedEntities.delete(scope);
  };

  return { guardEntity, liftEntityGuards, removedIds, startHydrate };
};

export type ReplicaEntityRemovalGuards = ReturnType<typeof createEntityRemovalGuards>;
