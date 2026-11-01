/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testDriver as driver } from '../../tests/testDriver';
import { defineReplica } from '../core/resource/defineReplica';
import { createMemoryStorage, resetScopeState, scope, wrapper } from '../zustand/testUtils';
import { createReplica } from './createReplica';

beforeEach(resetScopeState);

const setup = (fetcher = vi.fn(async ({ id }: { id: string }) => [`server ${id}`])) => {
  const storage = createMemoryStorage();
  const resource = defineReplica<{ id: string }, string[]>({
    fetcher,
    key: ({ id }) => id,
    name: 'hookList',
    scope,
    storage: storage.storage,
    version: 1,
  });
  return { fetcher, replica: createReplica(resource, { driver }), storage };
};

describe('createReplica', () => {
  it('returns the persisted row first, then the server value', async () => {
    let resolveFetch!: (value: string[]) => void;
    const { replica, storage } = setup(
      vi.fn(() => new Promise<string[]>((resolve) => (resolveFetch = resolve))),
    );
    storage.rows.set('user-1:personal|a', { data: ['cached'], updatedAt: 1 });

    const { result } = renderHook(() => replica.useReplica({ id: 'a' }), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(['cached']));
    expect(result.current.isHydrated).toBe(true);
    expect(result.current.isValidating).toBe(true);

    await act(async () => resolveFetch(['server']));

    await waitFor(() => expect(result.current.data).toEqual(['server']));
    expect(replica.read({ id: 'a' })).toEqual(['server']);
    await waitFor(() => expect(storage.rows.get('user-1:personal|a')?.data).toEqual(['server']));
  });

  it('reads nothing without params, and follows a key change', async () => {
    const { fetcher, replica } = setup();

    const { rerender, result } = renderHook(
      ({ id }: { id?: string }) => replica.useReplica(id ? { id } : null),
      { initialProps: {}, wrapper },
    );

    expect(result.current.data).toBeUndefined();
    expect(result.current.isHydrated).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ id: 'a' });
    await waitFor(() => expect(result.current.data).toEqual(['server a']));

    rerender({ id: 'b' });
    await waitFor(() => expect(result.current.data).toEqual(['server b']));
  });

  it('re-renders on writes through the returned methods, and stops after unmount', async () => {
    const { replica } = setup();
    const renders = vi.fn();

    const { result, unmount } = renderHook(
      () => {
        renders();
        return replica.useReplica({ id: 'a' });
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(['server a']));

    act(() => replica.replace({ id: 'a' }, ['edited']));
    expect(result.current.data).toEqual(['edited']);

    const listener = vi.fn();
    const unsubscribe = replica.subscribe(listener);
    unmount();
    const rendersAfterUnmount = renders.mock.calls.length;

    act(() => replica.replace({ id: 'a' }, ['again']));
    // Only the explicit subscriber hears it; the unmounted hook has let go.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(rendersAfterUnmount);
    expect(replica.read({ id: 'a' })).toEqual(['again']);

    unsubscribe();
    act(() => replica.replace({ id: 'a' }, ['last']));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
