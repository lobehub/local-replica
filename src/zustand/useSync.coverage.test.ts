/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { testDriver as driver } from '../../tests/testDriver';
import { defineReplica } from '../core/resource/defineReplica';
import { createReplicaState } from '../core/state/reducer';
import type { ReplicaRowKey } from '../storage/types';
import { createReplicaSlice } from './createReplicaSlice';
import { type ReplicaLens, recordLens } from './lens';
import {
  createMemoryStorage,
  resetScopeState,
  scope,
  scopeState,
  setup,
  type TestState,
  wrapper,
} from './testUtils';

beforeEach(resetScopeState);

const never = () => new Promise<string[]>(() => {});

/** Memory storage whose reads of `scope|queryKey` wait until released, one gate per read. */
const gatedStorage = () => {
  const memory = createMemoryStorage();
  const gates = new Map<string, (() => void)[]>();
  const held = new Set<string>();
  const get = async (key: ReplicaRowKey) => {
    const id = `${key.scope}|${key.queryKey}`;
    if (held.has(id)) {
      await new Promise<void>((resolve) => gates.set(id, [...(gates.get(id) ?? []), resolve]));
    }
    return memory.storage.get(key);
  };
  return {
    hold: (id: string) => held.add(id),
    memory: { ...memory, storage: { ...memory.storage, get } },
    pending: (id: string) => gates.get(id)?.length ?? 0,
    release: (id: string) => {
      held.delete(id);
      for (const resolve of gates.get(id) ?? []) resolve();
      gates.delete(id);
    },
  };
};

/** A lens that reads an empty list back as "no value", like a view that hides empty rows. */
const hidingEmptyLens = (): ReplicaLens<TestState, string[]> => {
  const base = recordLens<TestState, string[]>('lists');
  return {
    ...base,
    get: (state, key) => (base.get(state, key)?.length ? base.get(state, key) : undefined),
  };
};

describe('useSync', () => {
  it('re-runs its own sync through `revalidate`', async () => {
    const fetcher = vi.fn(async () => ['server']);
    const { slice } = setup({ fetcher });
    const { result } = renderHook(() => slice.useSync({ id: 'a' }), { wrapper });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.revalidate();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('runs no hydration side effects for a key the hook moved past mid-read', async () => {
    const gated = gatedStorage();
    gated.memory.rows.set('user-1:personal|a', { data: ['cached-a'], updatedAt: 1 });
    gated.memory.rows.set('user-1:personal|b', { data: ['cached-b'], updatedAt: 1 });
    gated.hold('user-1:personal|a');
    const { slice, store } = setup({ fetcher: never, storage: gated.memory });
    const seen: string[][] = [];

    const session = renderHook(
      ({ id }: { id: string }) => slice.useSync({ id }, { onHydrated: (data) => seen.push(data) }),
      { initialProps: { id: 'a' }, wrapper },
    );
    await waitFor(() => expect(gated.pending('user-1:personal|a')).toBe(1));
    session.rerender({ id: 'b' });
    await waitFor(() => expect(seen).toEqual([['cached-b']]));

    await act(async () => gated.release('user-1:personal|a'));

    // The read still fills `a`'s own entry, but `onHydrated` belongs to `b` now.
    await waitFor(() => expect(store.getState().lists.a).toEqual(['cached-a']));
    expect(seen).toEqual([['cached-b']]);
    session.unmount();
  });

  it('skips onHydrated when the view reads the hydrated row back as absent', async () => {
    const memory = createMemoryStorage();
    memory.rows.set('user-1:personal|a', { data: [], updatedAt: 1 });
    const resource = defineReplica<{ id: string }, string[]>({
      fetcher: never,
      key: ({ id }) => id,
      name: 'hidingEmpty',
      scope,
      storage: memory.storage,
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
      view: hidingEmptyLens(),
    });
    const onHydrated = vi.fn();

    const session = renderHook(() => slice.useSync({ id: 'a' }, { onHydrated }), { wrapper });
    await waitFor(() => expect(store.getState().listsReplica.entries.a?.source).toBe('storage'));

    // A → B → A: the entry is read again on return, and is still hidden.
    scopeState.current = 'user-2:personal';
    session.rerender();
    await waitFor(() => expect(store.getState().listsReplica.scope).toBe('user-2:personal'));
    scopeState.current = 'user-1:personal';
    session.rerender();
    await waitFor(() => expect(store.getState().listsReplica.entries.a?.source).toBe('storage'));
    await act(async () => {});

    expect(store.getState().lists.a).toEqual([]);
    expect(onHydrated).not.toHaveBeenCalled();
    session.unmount();
  });

  it('replays nothing on return to a scope whose partition has no row', async () => {
    const { slice, store } = setup({ fetcher: never });
    const onHydrated = vi.fn();
    const session = renderHook(() => slice.useSync({ id: 'a' }, { onHydrated }), { wrapper });
    await waitFor(() => expect(session.result.current.isHydrated).toBe(true));

    scopeState.current = 'user-2:personal';
    session.rerender();
    await waitFor(() => expect(store.getState().listsReplica.scope).toBe('user-2:personal'));
    scopeState.current = 'user-1:personal';
    session.rerender();
    await waitFor(() => expect(store.getState().listsReplica.scope).toBe('user-1:personal'));
    await act(async () => {});

    expect(store.getState().lists.a).toBeUndefined();
    expect(onHydrated).not.toHaveBeenCalled();
    session.unmount();
  });

  it('does not replay onHydrated when the hook moved on before the return read landed', async () => {
    const gated = gatedStorage();
    gated.memory.rows.set('user-1:personal|a', { data: ['cached-a1'], updatedAt: 1 });
    gated.memory.rows.set('user-2:personal|a', { data: ['cached-a2'], updatedAt: 1 });
    const { slice, store } = setup({ fetcher: never, storage: gated.memory });
    const seen: string[][] = [];

    const session = renderHook(
      ({ id }: { id: string }) => slice.useSync({ id }, { onHydrated: (data) => seen.push(data) }),
      { initialProps: { id: 'a' }, wrapper },
    );
    await waitFor(() => expect(seen).toEqual([['cached-a1']]));
    scopeState.current = 'user-2:personal';
    session.rerender({ id: 'a' });
    await waitFor(() => expect(seen).toEqual([['cached-a1'], ['cached-a2']]));

    // Back on user 1, the re-read of `a` stalls; meanwhile the hook moves to `c`.
    gated.hold('user-1:personal|a');
    scopeState.current = 'user-1:personal';
    session.rerender({ id: 'a' });
    await waitFor(() => expect(gated.pending('user-1:personal|a')).toBe(1));
    session.rerender({ id: 'c' });

    await act(async () => gated.release('user-1:personal|a'));

    // The row comes back into `a`'s entry, but `c` is on screen now.
    await waitFor(() => expect(store.getState().lists.a).toEqual(['cached-a1']));
    expect(seen).toEqual([['cached-a1'], ['cached-a2']]);
    session.unmount();
  });
});
