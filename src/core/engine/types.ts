import type { ReplicaEntityAdapter } from '../entity/types';
import type { ReplicaViewWrite } from '../state/reducer';
import type { ReplicaState } from '../state/types';

/**
 * The engine's view of the host store. The engine never owns the rendered
 * value — the host does (a Zustand slice, a signal, a plain object) — it only
 * reads entries through `read` and hands every transition to `commit`.
 */
export interface ReplicaStorePort<TData> {
  /**
   * Apply the view writes and the next bookkeeping slot as ONE host update, so
   * subscribers never observe a view out of step with its bookkeeping.
   */
  commit: (writes: ReplicaViewWrite<TData>[], state: ReplicaState<TData>, label: string) => void;
  /** Current bookkeeping slot. */
  getState: () => ReplicaState<TData>;
  /** Enumerate loaded keys (entity propagation). Defaults to the bookkeeping entries. */
  keys?: () => string[];
  /** Materialized value of one entry, as the UI sees it. */
  read: (key: string) => TData | undefined;
}

export interface ReplicaEngineOptions<TParams, TData, TFetched> {
  /** Label prefix of host updates (devtools action names). Defaults to the resource name. */
  actionPrefix?: string;
  /** Non-paged resources: how entities sit in the value (see `linkReplicaEntity`). */
  entity?: ReplicaEntityAdapter<TData, any>;
  /** Overrides `resource.fetcher` when the fetch needs store context. */
  fetcher?: (params: TParams, cursor?: any) => Promise<TFetched>;
  /** Paged: rows that only exist client-side (kept across refreshes, never persisted). */
  isClientOnly?: (item: any) => boolean;
  /** Reject a persisted value that cannot serve these params. Rarely needed: rows are stored per query. */
  isHydratable?: (cached: TData, params: TParams) => boolean;
  /**
   * Non-paged: whether a head response means the entry no longer exists. Such a
   * response is applied as an explicit removal (memory + persisted row) instead
   * of through `merge` — otherwise a `null` would fall back to the confirmed
   * value (the reducer resolves `action.data(confirmed) ?? confirmed`), so a
   * deleted aggregate would be retained and re-persisted.
   */
  isMissing?: (incoming: TFetched) => boolean;
  /**
   * Non-paged: fold a server response into the confirmed value. Return
   * `undefined` to keep the current value. Defaults to "the response is the value".
   */
  merge?: (incoming: TFetched, confirmed: TData | undefined, params: TParams) => TData | undefined;
  /** Where the engine reads and commits the view. */
  port: ReplicaStorePort<TData>;
  /**
   * Reconcile a server response with the value currently shown before it is
   * folded in — e.g. keep a row the client knows is newer, or ignore a
   * response that raced a newer local state. Return `undefined` to drop the
   * response entirely.
   */
  prepareHead?: (
    incoming: TFetched,
    current: TData | undefined,
    params: TParams,
  ) => TFetched | undefined;
  /** Re-run the network sync of one entry (or all); wired by the fetch adapter. */
  revalidate?: (key?: string) => Promise<unknown>;
  /**
   * Strip transient / client-only parts before persisting.
   *
   * - a value → persisted
   * - `undefined` → skip this write (keep whatever is already stored)
   * - `null` → the entry is a server-confirmed absence: drop any prior
   *   persisted projection, so a later hydrate cannot paint a value the server
   *   no longer has (the view keeps the confirmed value).
   */
  toPersisted?: (data: TData) => TData | null | undefined;
  /** Paged: domain fields derived from params, written with every head page. */
  viewFields?: (params: TParams) => Partial<TData>;
}

/** What a head response did once folded in (see `applyHead`). */
export type ReplicaHeadOutcome = 'dropped' | 'missing' | 'replaced';

export interface OptimisticMutationOptions<TData, TResult> {
  /** Turn the server result into the confirmed value; defaults to re-applying `apply`. */
  confirm?: (result: TResult) => (data: TData) => TData;
  /** Revalidate the entry after the server call settles. */
  revalidate?: boolean;
}

/** Handle of an optimistic overlay that is settled later (see `beginOptimistic`). */
export interface ReplicaOptimisticToken<TData> {
  commit: (confirm?: (data: TData) => TData) => void;
  rollback: () => void;
}
