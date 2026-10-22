import type { ReplicaEngineOptions } from '../core/engine/types';
import type { ReplicaSyncDriver, ReplicaSyncSchedule } from './driver';
import type { ReplicaLens } from './lens';

/** Zustand `setState`, with the devtools action label. */
type Setter<TStore> = (partial: Partial<TStore>, replace?: false, action?: any) => void;

export interface CreateReplicaSliceOptions<TStore, TParams, TData, TFetched> extends Omit<
  ReplicaEngineOptions<TParams, TData, TFetched>,
  'port' | 'revalidate'
> {
  /** Query cache that schedules fetches (see `createSWRDriver`). */
  driver: ReplicaSyncDriver;
  /**
   * Side effects of the resource itself, run by every head response — a
   * mounted `useSync` and an imperative `fetch` alike — after the response is
   * folded in (see {@link ReplicaEffects}).
   */
  effects?: ReplicaEffects<TParams, TFetched>;
  get: () => TStore;
  set: Setter<TStore>;
  /** Store field holding the {@link ReplicaState} bookkeeping slot. */
  stateKey: keyof TStore & string;
  /** Where the view lives in the store; `recordLens(field)` covers `Record<key, TData>`. */
  view: ReplicaLens<TStore, TData>;
}

/**
 * What a failed sync read was captured under. `scope` is the cache scope active
 * when the request was issued, which may differ from the scope active when the
 * callback runs (an identity / workspace switch in between).
 */
export interface ReplicaSyncErrorContext {
  /**
   * Whether the captured `scope` is still the one the store is on. A failure
   * with `isActive: false` belongs to an identity / workspace the store has
   * left: surface it on the *current* view only when this is true, while still
   * using the captured `key` / `scope` to clean up the scope it came from.
   */
  isActive: boolean;
  /** The entry key the read was for; `undefined` for a disabled read. */
  key: string | undefined;
  /** The cache scope the read was captured under. */
  scope: string;
}

/** Where a settled head response was captured, for {@link ReplicaEffects}. */
export interface ReplicaSettleContext {
  key: string;
  /** The cache scope the request was captured under (the active one, except for `onPurge`). */
  scope: string;
  /** Which path requested it: a mounted `useSync`, or `slice.fetch`. */
  source: 'fetch' | 'sync';
}

/**
 * Resource-level side effects of head responses. Unlike `useSync`'s per-call
 * `onSuccess` / `onError` (UI callbacks of one mounted view), these run for
 * every response the resource settles, whichever path requested it — so a
 * store that fetches while no view is mounted keeps the same side effects.
 *
 * They run only for a response that passed every guard (clear, removal, active
 * query, a newer response already applied) and, for `onApplied` / `onMissing`,
 * only when its captured scope is still the active one.
 */
export interface ReplicaEffects<TParams, TFetched> {
  /**
   * A response was folded into the active scope (`prepareHead` kept it and it
   * is not a terminal absence). Runs even when the value did not change.
   */
  onApplied?: (data: TFetched, params: TParams, context: ReplicaSettleContext) => void;
  /**
   * A failed head read. Like `useSync`'s `onError`, it is forwarded off-scope
   * too, with `isActive: false`: use the captured key / scope to clean up that
   * scope, and touch the view on screen only when `isActive`.
   */
  onError?: (error: unknown, params: TParams, context: ReplicaSyncErrorContext) => void;
  /**
   * The response was a terminal absence (`isMissing`) and the entry was
   * removed from the active scope. An absence captured under a scope the store
   * has left purges that scope's row and runs `onPurge` instead.
   */
  onMissing?: (params: TParams, context: ReplicaSettleContext) => void;
  /**
   * A terminal absence captured under a scope the store has since left. The
   * entry's row in that scope is already purged; purge what other resources
   * keep of it there (a linked list row). Never touch the view on screen.
   */
  onPurge?: (params: TParams, context: ReplicaSettleContext) => void;
}

export interface ReplicaFetchOptions {
  /**
   * Start a new request even when one for the same entry is in flight, and
   * retire every request started before it: a late response of an older one
   * is dropped instead of applied. Use it for refreshes after a mutation,
   * where an in-flight request may hold the pre-mutation value. By default
   * `fetch` joins the request in flight (a `useSync` one or another `fetch`).
   */
  fresh?: boolean;
  /**
   * The cache scope the fetch belongs to, captured by a caller that started a
   * multi-step flow earlier (a warmup fanning out from a parent response). The
   * response settles into that scope under the same off-scope rules as any
   * other. When the scope is no longer active the fetch rejects without a
   * request: it would read the new identity's data under the old one's label.
   * Defaults to the active scope.
   */
  scope?: string;
}

export interface ReplicaFetchResult<TFetched> {
  /**
   * Whether the response was settled into the active scope: folded in, or
   * applied as a terminal absence. `false` when a guard dropped it (scope
   * switch, `remove` / `clear` mid-flight, superseded) or `prepareHead` did.
   */
  applied: boolean;
  /** The response as fetched, also when it was not applied. */
  data: TFetched;
  /** The response was a terminal absence (`isMissing`), in whichever scope. */
  missing: boolean;
}

export interface ReplicaSyncOptions<
  TFetched = unknown,
  TData = unknown,
> extends ReplicaSyncSchedule {
  enabled?: boolean;
  /**
   * Side effects of a failed fetch (error side-maps); the store view is left as is.
   * Receives the captured {@link ReplicaSyncErrorContext} so a terminal removal
   * can target the scope the request belonged to rather than the one that is
   * active once the callback runs.
   */
  onError?: (error: unknown, context: ReplicaSyncErrorContext) => void;
  /**
   * Side effects of a hydrated persisted value, run after it is folded into the
   * replica. A cold start with no network (offline / slow) has no response for
   * `onSuccess` to run on, so the same "success" handling must also run off the
   * persisted value it paints.
   */
  onHydrated?: (data: TData) => void;
  /**
   * Side effects of a response, run after it is folded into the replica
   * (e.g. adopting an active id). UI callbacks of this view only: effects every
   * response of the resource needs belong in the slice's `effects`, which
   * `fetch` runs too.
   */
  onSuccess?: (data: TFetched) => void;
}

export interface ReplicaSyncResult {
  error: unknown;
  /** The persisted row has been read (or there is nothing to read). */
  isHydrated: boolean;
  /** A network request is in flight. Never a reason to hide store data. */
  isValidating: boolean;
  /** Re-run the network sync for this entry. */
  revalidate: () => Promise<unknown>;
}
