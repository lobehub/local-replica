import { replicaKeys } from '../core/resource/queryKeys';
import { stableQueryKey } from '../core/resource/storageKey';
import type { ReplicaResource } from '../core/resource/types';

/** One head request, from `begin` to `settle`. */
export interface ReplicaRequest<TParams, TFetched> {
  /** `clear()` generation of `scope` when the request started. */
  clearGeneration: number;
  key: string;
  params: TParams;
  /** Settles the request; set once it is sent. */
  promise?: Promise<TFetched>;
  /** Row key of the query it asks for (`headQuery` guard). */
  queryKey: string;
  /** `remove` generation of `scope` + `key` when the request started. */
  removalGeneration: number;
  /** Scope + sync key: requests of the same id dedupe and supersede each other. */
  requestId: string;
  /** The cache scope it was captured under. */
  scope: string;
  /** Start order across the slice. */
  seq: number;
  /** What it settled to; a request is settled once (a joined fetch and its sync share it). */
  settled?: ReplicaSettled;
  /** The response (or failure) it settled with. */
  settledWith?: unknown;
  source: 'fetch' | 'sync';
  syncKey: readonly unknown[];
}

export interface ReplicaSettled {
  /** Settled into the active scope (folded in or removed as missing). */
  applied: boolean;
  /** Passed every guard; `isActive` says whether its scope is still on screen. */
  current: boolean;
  isActive: boolean;
  missing: boolean;
}

export type ReplicaOutcome<TFetched> = { data: TFetched } | { error: unknown };

export interface ReplicaRequestsDeps<TParams, TFetched> {
  clearGeneration: (scope: string) => number;
  fetcher?: (params: TParams, cursor?: any) => Promise<TFetched>;
  /** Fold a request's outcome into the replica (guards, `applyHead`, effects); runs once. */
  fold: (
    request: ReplicaRequest<TParams, TFetched>,
    outcome: ReplicaOutcome<TFetched>,
  ) => ReplicaSettled;
  removalGeneration: (scope: string, key: string) => number;
  resource: ReplicaResource<TParams, any, TFetched>;
}

/** Request id of a sync key in a scope: requests of the same id dedupe and supersede. */
export const replicaRequestId = (scope: string, syncKey: unknown) =>
  `${scope}\u0000${stableQueryKey(syncKey)}`;

/**
 * Lifecycle bookkeeping of head requests: capture (`begin`), send and track in
 * flight, retire older requests once a newer response applied, and settle each
 * request exactly once. What settling *does* is the slice's `fold`; this only
 * guarantees every path — a mounted `useSync`, or `fetch` with no view mounted
 * — goes through it the same way.
 */
export const createRequests = <TParams, TFetched>({
  clearGeneration,
  fetcher,
  fold,
  removalGeneration,
  resource,
}: ReplicaRequestsDeps<TParams, TFetched>) => {
  let requestSeq = 0;

  /**
   * Requests whose start order is at or below this number are retired, per
   * request id: a newer response already applied, or a `fresh` fetch started
   * after them. Their late response would repaint an older value.
   *
   * An entry only matters while a request it retires is still unsettled:
   * every request started later has a higher sequence, so a missing entry
   * (read as 0) admits exactly the same responses. Entries are pruned as soon
   * as no sent request at or below them is pending, so the map holds only the
   * ids with an older request in flight.
   */
  const retiredThrough = new Map<string, number>();
  /** Sequences of the sent requests that have not settled yet, per request id. */
  const unsettled = new Map<string, Set<number>>();

  /** Drop the retirement of `requestId` once no request it retires is pending. */
  const pruneRetired = (requestId: string) => {
    const through = retiredThrough.get(requestId);
    if (through === undefined) return;
    for (const seq of unsettled.get(requestId) ?? []) if (seq <= through) return;
    retiredThrough.delete(requestId);
  };

  const retire = (requestId: string, seq: number) => {
    if ((retiredThrough.get(requestId) ?? 0) < seq) retiredThrough.set(requestId, seq);
    // Every entry is pruned the moment it stops retiring a pending request
    // (here, and as each request settles), so the map stays bounded by the ids
    // with an older request in flight — no size backstop needed. Evicting an
    // entry that still retires one would let its stale response win.
    pruneRetired(requestId);
  };

  /** A newer response already applied, or a `fresh` fetch started after it. */
  const isRetired = ({ requestId, seq }: ReplicaRequest<TParams, TFetched>) =>
    seq <= (retiredThrough.get(requestId) ?? 0);

  const trackUnsettled = ({ requestId, seq }: ReplicaRequest<TParams, TFetched>) => {
    const pending = unsettled.get(requestId) ?? new Set<number>();
    unsettled.set(requestId, pending);
    pending.add(seq);
  };

  const untrackUnsettled = ({ requestId, seq }: ReplicaRequest<TParams, TFetched>) => {
    const pending = unsettled.get(requestId);
    if (!pending?.delete(seq)) return;
    if (pending.size === 0) unsettled.delete(requestId);
    pruneRetired(requestId);
  };

  /** The latest request in flight per id, which a non-`fresh` `fetch` joins. */
  const inflight = new Map<string, ReplicaRequest<TParams, TFetched>>();
  /** `useSync` requests in flight per id (`fetch` seeds the driver only while none is). */
  const syncInflight = new Map<string, number>();

  /**
   * `useSync` request each sync id last started, settled by the driver's
   * callback. The driver settles one request per key at a time (a newer
   * request supersedes the older one), so the latest start is the one that
   * settles.
   */
  const syncRequests = new Map<string, ReplicaRequest<TParams, TFetched>>();

  const syncKeyOf = (params: TParams, scope: string, key: string) =>
    resource.syncKey?.(params) ??
    replicaKeys.sync(resource.name, resource.version, scope, key, params);

  /** Capture what a head request for `params` started under. */
  const begin = (
    params: TParams,
    scope: string,
    source: 'fetch' | 'sync',
  ): ReplicaRequest<TParams, TFetched> => {
    const key = resource.key(params);
    const syncKey = syncKeyOf(params, scope, key);
    return {
      clearGeneration: clearGeneration(scope),
      key,
      params,
      queryKey: resource.storageKey(params),
      removalGeneration: removalGeneration(scope, key),
      requestId: replicaRequestId(scope, syncKey),
      scope,
      seq: ++requestSeq,
      source,
      syncKey,
    };
  };

  /** Send the request and track it in flight until it settles. */
  const send = (request: ReplicaRequest<TParams, TFetched>) => {
    const { requestId } = request;
    const sent = fetcher!(request.params, undefined);
    // Tolerate a fetcher (a test double) that does not return a promise: the
    // driver still gets exactly what it returned.
    const promise = Promise.resolve(sent);
    request.promise = promise;
    // Until it settles, a retirement that covers it must be kept.
    trackUnsettled(request);
    inflight.set(requestId, request);
    if (request.source === 'sync')
      syncInflight.set(requestId, (syncInflight.get(requestId) ?? 0) + 1);
    const done = () => {
      if (inflight.get(requestId) === request) inflight.delete(requestId);
      if (request.source !== 'sync') return;
      // Incremented before this `done` was attached, so the count is present.
      const count = syncInflight.get(requestId)! - 1;
      if (count > 0) syncInflight.set(requestId, count);
      else syncInflight.delete(requestId);
    };
    promise.then(done, done);
    // A `useSync` request settles on its own response, not only through the
    // driver's callback: a driver skips that callback once the hook moved to
    // another key, unmounted, or a newer request superseded it — and the
    // resource effects (a terminal absence, a purge) must not depend on which
    // view is still mounted. The callback then reads the memoized result.
    if (request.source === 'sync')
      promise.then(
        (data) => settle(request, { data }),
        (error: unknown) => settle(request, { error }),
      );
    return sent;
  };

  /**
   * Fold a settled head request into the replica (see the slice's `fold`). A
   * request is settled once: a `fetch` that joined a `useSync` request shares
   * its result.
   */
  const settle = (
    request: ReplicaRequest<TParams, TFetched>,
    outcome: ReplicaOutcome<TFetched>,
  ): ReplicaSettled => {
    if (request.settled) return request.settled;
    request.settledWith = 'error' in outcome ? outcome.error : outcome.data;
    request.settled = fold(request, outcome);
    untrackUnsettled(request);
    if (request.source === 'sync') releaseSyncRequest(request);
    return request.settled;
  };

  /**
   * Drop a settled `useSync` request's record once its driver callback had its
   * chance to read it. The record is normally taken by that callback, but the
   * driver skips it when the hook changed key, unmounted or was superseded —
   * the request still settles on its own promise, and its record (holding the
   * response) must not stay behind. A driver runs the callback in the same
   * turn the response resolves (SWR does, in microtasks), so a macrotask later
   * the record is only a leak.
   */
  const releaseSyncRequest = (request: ReplicaRequest<TParams, TFetched>) => {
    setTimeout(() => {
      if (syncRequests.get(request.requestId) === request) syncRequests.delete(request.requestId);
    }, 0);
  };

  /** Start a `useSync` request and record it for the driver's callback. */
  const startSync = (params: TParams, scope: string) => {
    const request = begin(params, scope, 'sync');
    syncRequests.set(request.requestId, request);
    return send(request);
  };

  /**
   * The `useSync` request settling now: the one `requestId` last started. A
   * response the driver settles without having run our fetcher (a
   * cache-shared key), or one the recorded request did not produce, is
   * captured now: nothing it started under is known.
   */
  const takeSyncRequest = (
    requestId: string,
    response: unknown,
    params: TParams,
    scope: string,
  ): ReplicaRequest<TParams, TFetched> => {
    const request = syncRequests.get(requestId);
    syncRequests.delete(requestId);
    // The request already settled on its own response, and the driver now
    // reports that same response: read the memoized result.
    if (request && (!request.settled || request.settledWith === response)) return request;
    return begin(params, scope, 'sync');
  };

  return {
    begin,
    /** Records of `useSync` requests not yet released (leak checks in tests). */
    debugPendingSyncRequests: () => syncRequests.size,
    /** Retirement records still held (leak checks in tests). */
    debugRetiredRequests: () => retiredThrough.size,
    /** The request in flight for `requestId`, which a non-`fresh` `fetch` joins. */
    inflight: (requestId: string) => inflight.get(requestId),
    isRetired,
    /** Whether a `useSync` request of `requestId` is in flight. */
    isSyncInflight: (requestId: string) => syncInflight.has(requestId),
    retire,
    send,
    settle,
    startSync,
    syncKeyOf,
    takeSyncRequest,
  };
};

export type ReplicaRequests<TParams, TFetched> = ReturnType<
  typeof createRequests<TParams, TFetched>
>;
