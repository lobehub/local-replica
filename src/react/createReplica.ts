import { useSyncExternalStore } from 'react';

import type { ReplicaResource } from '../core/resource/types';
import { createReplicaState } from '../core/state/reducer';
import type { ReplicaState } from '../core/state/types';
import { createReplicaSlice } from '../zustand/createReplicaSlice';
import { recordLens } from '../zustand/lens';
import type {
  CreateReplicaSliceOptions,
  ReplicaSyncOptions,
  ReplicaSyncResult,
} from '../zustand/types';

/** The store `createReplica` keeps for itself: the rendered values and their bookkeeping. */
interface ReplicaOwnStore<TData> {
  data: Record<string, TData>;
  replica: ReplicaState<TData>;
}

export type CreateReplicaOptions<TParams, TData, TFetched = TData> = Omit<
  CreateReplicaSliceOptions<ReplicaOwnStore<TData>, TParams, TData, TFetched>,
  'get' | 'set' | 'stateKey' | 'view'
>;

export interface UseReplicaResult<TData> extends ReplicaSyncResult {
  /** The value on screen: the replica first, then each server response folded in. */
  data: TData | undefined;
}

/**
 * Bind a replica without a store of your own. The hook returns the data, like
 * `useSWR`, while the replica keeps it in a store private to this resource.
 *
 * Reach for `createReplicaSlice` instead when the data must live in an app
 * store (selectors across views, devtools, state shared with other slices).
 */
export const createReplica = <TParams, TData, TFetched = TData>(
  resource: ReplicaResource<TParams, TData, TFetched>,
  options: CreateReplicaOptions<TParams, TData, TFetched>,
) => {
  let state: ReplicaOwnStore<TData> = { data: {}, replica: createReplicaState() };
  const listeners = new Set<() => void>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const slice = createReplicaSlice<ReplicaOwnStore<TData>, TParams, TData, TFetched>(resource, {
    ...options,
    get: () => state,
    set: (partial) => {
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    stateKey: 'replica',
    view: recordLens('data'),
  });

  /** The value on screen for `params`, outside React. */
  const read = (params: TParams): TData | undefined => state.data[resource.key(params)];

  /**
   * Hydrate the persisted row, sync with the server, and return the value on
   * screen. `null` / `undefined` params read nothing, like a disabled `useSWR`.
   */
  const useReplica = (
    params: TParams | null | undefined,
    syncOptions?: ReplicaSyncOptions<TFetched, TData>,
  ): UseReplicaResult<TData> => {
    const sync = slice.useSync(params, syncOptions);
    const key = params ? resource.key(params) : undefined;
    const getSnapshot = () => (key === undefined ? undefined : state.data[key]);
    const data = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // Not `{ ...sync, data }`: a spread invokes `useSync`'s lazy `error` /
    // `isValidating` getters and re-subscribes every caller to them (see
    // `createUseSync`). Forward them as getters instead.
    return {
      data,
      get error() {
        return sync.error;
      },
      isHydrated: sync.isHydrated,
      get isValidating() {
        return sync.isValidating;
      },
      revalidate: sync.revalidate,
    };
  };

  return { ...slice, read, subscribe, useReplica };
};

export type Replica<TParams, TData, TFetched = TData> = ReturnType<
  typeof createReplica<TParams, TData, TFetched>
>;
