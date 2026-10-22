/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { testDriver as driver } from '../../tests/testDriver';
import { defineReplica } from '../core/resource/defineReplica';
import { createReplicaState } from '../core/state/reducer';
import { createReplicaSlice } from './createReplicaSlice';
import { recordLens } from './lens';
import { resetScopeState, scope, setup, type TestState, wrapper } from './testUtils';

beforeEach(resetScopeState);

interface FilteredParams {
  filter: string;
  id: string;
}

const filteredSetup = (fetcher: (params: FilteredParams) => Promise<string[]>) => {
  const resource = defineReplica<FilteredParams, string[]>({
    fetcher,
    key: ({ id }) => id,
    name: 'filtered',
    query: ({ filter }) => ({ filter }),
    scope,
    version: 1,
  });
  const store = createStore<TestState>()(() => ({
    lists: {},
    listsReplica: createReplicaState(),
  }));
  const slice = createReplicaSlice<TestState, FilteredParams, string[]>(resource, {
    driver,
    get: store.getState,
    set: (partial) => store.setState(partial),
    stateKey: 'listsReplica',
    view: recordLens('lists'),
  });
  return { slice, store };
};

describe('createReplicaSlice', () => {
  it('revalidates only the mounted sync of the requested key', async () => {
    const fetcher = vi.fn(async ({ id }: { id: string }) => [`server-${id}`]);
    const { slice, store } = setup({ fetcher });
    // `slice.revalidate` matches through the driver's global `mutate`, so this
    // view syncs on SWR's default cache (a key no other test uses).
    const session = renderHook(() => slice.useSync({ id: 'revalidate-a' }));
    await waitFor(() =>
      expect(store.getState().lists['revalidate-a']).toEqual(['server-revalidate-a']),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await slice.revalidate('revalidate-b');
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await slice.revalidate('revalidate-a');
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    session.unmount();
  });

  it('rejects `fetch` for a resource without a fetcher', async () => {
    const resource = defineReplica<{ id: string }, string[]>({
      key: ({ id }) => id,
      name: 'noFetcher',
      scope,
      version: 1,
    });
    const store = createStore<TestState>()(() => ({
      lists: {},
      listsReplica: createReplicaState(),
    }));
    const slice = createReplicaSlice<TestState, { id: string }, string[]>(resource, {
      driver,
      get: store.getState,
      set: (partial) => store.setState(partial),
      stateKey: 'listsReplica',
      view: recordLens('lists'),
    });

    await expect(slice.fetch({ id: 'a' })).rejects.toThrow('[replica] noFetcher has no fetcher');
  });

  it('lets `fetch` land over a mounted view only for the query that view shows', async () => {
    // The mounted sync never answers, so only `fetch` responses reach the entry.
    const fetcher = vi.fn(({ filter }: FilteredParams) =>
      filter === 'mounted' ? new Promise<string[]>(() => {}) : Promise.resolve([filter]),
    );
    const { slice, store } = filteredSetup(fetcher);
    renderHook(() => slice.useSync({ filter: 'mounted', id: 'a' }), { wrapper });

    const other = await slice.fetch({ filter: 'other', id: 'a' });
    expect(other).toEqual({ applied: false, data: ['other'], missing: false });
    expect(store.getState().lists.a).toBeUndefined();

    fetcher.mockImplementationOnce(async () => ['mounted-fresh']);
    const same = await act(() => slice.fetch({ filter: 'mounted', id: 'a' }, { fresh: true }));
    expect(same).toEqual({ applied: true, data: ['mounted-fresh'], missing: false });
    expect(store.getState().lists.a).toEqual(['mounted-fresh']);
  });
});
