/**
 * @vitest-environment happy-dom
 */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defineReplica } from '../core/resource/defineReplica';
import { createReplica } from '../react/createReplica';
import { createReactQueryDriver, type ReactQueryLikeHook } from './reactQueryDriver';
import { createMemoryStorage, resetScopeState, scope } from './testUtils';

beforeEach(resetScopeState);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const setup = (fetcher = vi.fn(async ({ id }: { id: string }) => [`server ${id}`])) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const storage = createMemoryStorage();
  const resource = defineReplica<{ id: string }, string[]>({
    fetcher,
    key: ({ id }) => id,
    name: 'rqList',
    scope,
    storage: storage.storage,
    version: 1,
  });
  const replica = createReplica(resource, {
    driver: createReactQueryDriver({ queryClient, useQuery }),
  });
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { fetcher, queryClient, replica, storage, wrapper };
};

describe('createReactQueryDriver', () => {
  it('paints the persisted row, then the server value, and persists it', async () => {
    const request = deferred<string[]>();
    const { replica, storage, wrapper } = setup(vi.fn(() => request.promise));
    storage.rows.set('user-1:personal|a', { data: ['cached'], updatedAt: 1 });

    const { result } = renderHook(() => replica.useReplica({ id: 'a' }), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(['cached']));
    expect(result.current.isValidating).toBe(true);

    await act(async () => request.resolve(['server']));

    await waitFor(() => expect(result.current.data).toEqual(['server']));
    expect(result.current.isValidating).toBe(false);
    await waitFor(() => expect(storage.rows.get('user-1:personal|a')?.data).toEqual(['server']));
  });

  it('runs onSuccess for the latest request only, after a revalidate replaced one in flight', async () => {
    const requests = [deferred<string[]>(), deferred<string[]>(), deferred<string[]>()];
    let call = 0;
    const { replica, wrapper } = setup(vi.fn(() => requests[call++].promise));
    const onSuccess = vi.fn();

    const { result } = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess }), {
      wrapper,
    });
    await act(async () => requests[0].resolve(['first']));
    await waitFor(() => expect(result.current.data).toEqual(['first']));

    // A refetch in flight, then a revalidate that replaces it (TanStack only
    // replaces a fetch once the query has data; before that it joins it).
    await act(async () => {
      void replica.revalidate('a');
    });
    await act(async () => {
      void replica.revalidate('a');
    });
    await waitFor(() => expect(call).toBe(3));

    await act(async () => requests[2].resolve(['newer']));
    await act(async () => requests[1].resolve(['older']));

    await waitFor(() => expect(result.current.data).toEqual(['newer']));
    // The overtaken request settled on its own and was dropped; it never reached the view's callback.
    expect(onSuccess.mock.calls).toEqual([[['first']], [['newer']]]);
  });

  it('drops a request that lands after the hook switched to another key', async () => {
    const requests = { a: deferred<string[]>(), b: deferred<string[]>() };
    const fetcher = vi.fn(({ id }: { id: string }) => requests[id as 'a' | 'b'].promise);
    const { replica, wrapper } = setup(fetcher);
    const onSuccess = vi.fn();

    const { rerender } = renderHook(
      ({ id }: { id: string }) => replica.useReplica({ id }, { onSuccess }),
      { initialProps: { id: 'a' }, wrapper },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // The same hook now shows `b` while `a` is still fetching.
    rerender({ id: 'b' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await act(async () => requests.a.resolve(['a-row']));
    // `a` settled after the switch: its data must not reach the `b` render.
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => requests.b.resolve(['b-row']));
    await waitFor(() => expect(onSuccess.mock.calls).toEqual([[['b-row']]]));
  });

  it('reports a failure to onError and keeps the value on screen', async () => {
    const failure = new Error('offline');
    const { replica, storage, wrapper } = setup(
      vi.fn(async () => {
        throw failure;
      }),
    );
    storage.rows.set('user-1:personal|a', { data: ['cached'], updatedAt: 1 });
    const onError = vi.fn();

    const { result } = renderHook(() => replica.useReplica({ id: 'a' }, { onError }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(onError).toHaveBeenCalledWith(failure, expect.objectContaining({ key: 'a' }));
    expect(result.current.data).toEqual(['cached']);

    // A revalidate whose request fails resolves; the failure goes to onError again.
    await act(async () => {
      await expect(replica.revalidate('a')).resolves.toBeDefined();
    });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('holds the request while paused, or until revalidate with revalidateOnMount: false', async () => {
    const { fetcher, replica, wrapper } = setup();

    renderHook(() => replica.useReplica({ id: 'a' }, { isPaused: () => true }), { wrapper });
    const { result } = renderHook(
      () => replica.useReplica({ id: 'b' }, { revalidateOnMount: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.revalidate();
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ id: 'b' }, undefined);
    await waitFor(() => expect(result.current.data).toEqual(['server b']));
  });

  it('holds an explicit revalidate while paused, and runs it once the pause lifts', async () => {
    const { fetcher, replica, wrapper } = setup();
    let paused = true;

    const { result, rerender } = renderHook(
      () => replica.useReplica({ id: 'a' }, { isPaused: () => paused }),
      { wrapper },
    );

    await act(async () => {
      await result.current.revalidate();
    });
    expect(fetcher).not.toHaveBeenCalled();

    paused = false;
    rerender();

    await waitFor(() => expect(result.current.data).toEqual(['server a']));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ id: 'a' }, undefined);
  });

  it('leaves a paused query out of a driver revalidate', async () => {
    const { fetcher, replica, wrapper } = setup();
    renderHook(() => replica.useReplica({ id: 'a' }, { isPaused: () => true }), { wrapper });
    const live = renderHook(() => replica.useReplica({ id: 'b' }), { wrapper });
    await waitFor(() => expect(live.result.current.data).toEqual(['server b']));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await replica.revalidate();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith({ id: 'b' }, undefined);
  });

  it('re-runs mounted queries only on revalidate', async () => {
    const { fetcher, replica, wrapper } = setup();
    const { unmount } = renderHook(() => replica.useReplica({ id: 'a' }), { wrapper });
    const mounted = renderHook(() => replica.useReplica({ id: 'b' }), { wrapper });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () => {
      await replica.revalidate();
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenLastCalledWith({ id: 'b' }, undefined);
    await waitFor(() => expect(mounted.result.current.data).toEqual(['server b']));
  });

  it('settles a request that lands after unmount without running the view callback', async () => {
    const request = deferred<string[]>();
    const { replica, wrapper } = setup(vi.fn(() => request.promise));
    const onSuccess = vi.fn();

    const { unmount } = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess }), {
      wrapper,
    });
    await waitFor(() => expect(replica.read({ id: 'a' })).toBeUndefined());
    unmount();
    await act(async () => request.resolve(['late']));

    await waitFor(() => expect(replica.read({ id: 'a' })).toEqual(['late']));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('seeds the query cache with what fetch applied', async () => {
    const { queryClient, replica } = setup();
    const seed = vi.spyOn(queryClient, 'setQueryData');

    await replica.fetch({ id: 'a' });

    expect(seed).toHaveBeenCalledWith(expect.any(Array), ['server a']);
  });

  describe('options', () => {
    const capture = () => {
      const result = { data: undefined, error: null, isFetching: false, refetch: vi.fn() };
      const useQueryHook = vi.fn<ReactQueryLikeHook>(() => result);
      const driver = createReactQueryDriver({
        queryClient: new QueryClient(),
        useQuery: useQueryHook,
      });
      return { driver, options: () => useQueryHook.mock.lastCall![0], result };
    };

    it('maps the SWR-named schedule onto useQuery options', () => {
      const { driver, options } = capture();
      const refreshInterval = vi.fn((data: unknown) => (data ? 1000 : 0));

      renderHook(() =>
        driver.useQuery(['k'], async () => 1, {
          dedupingInterval: 5,
          refreshInterval,
          refreshWhenHidden: true,
          refreshWhenOffline: true,
          revalidateIfStale: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: true,
        }),
      );

      expect(options()).toMatchObject({
        enabled: true,
        networkMode: 'always',
        queryKey: ['k'],
        refetchIntervalInBackground: true,
        refetchOnMount: false,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        staleTime: 5,
      });
      expect(options().refetchInterval({ state: { data: 'x' } })).toBe(1000);
      expect(options().refetchInterval({ state: { data: undefined } })).toBe(false);
    });

    it('turns a zero interval off, and pins a once query', () => {
      const { driver, options } = capture();

      renderHook(() =>
        driver.useQuery(['k'], async () => 1, { once: true, refreshInterval: 0, revalidateOnFocus: true }),
      );

      expect(options()).toMatchObject({
        refetchInterval: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      });
      expect(options()).not.toHaveProperty('networkMode');
    });

    it('disables a query without a key, and reports no error as undefined', () => {
      const { driver, options } = capture();

      const { result } = renderHook(() => driver.useQuery(null, async () => 1, {}));

      expect(options()).toMatchObject({ enabled: false, queryKey: ['local-replica', 'disabled'] });
      expect(result.current.error).toBeUndefined();
    });

    it('returns null for undefined data, and arms the query on mutate', async () => {
      const { driver, options, result: query } = capture();
      const onSuccess = vi.fn();

      const { result } = renderHook(() =>
        driver.useQuery(['k'], async () => undefined, { onSuccess, revalidateOnMount: false }),
      );
      expect(options().enabled).toBe(false);

      await expect(options().queryFn()).resolves.toBeNull();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith(undefined);

      act(() => void result.current.mutate());
      expect(query.refetch).toHaveBeenCalledOnce();
      expect(options().enabled).toBe(true);
    });

    it('does not refetch a paused query on mutate, and arms it for when the pause lifts', () => {
      const { driver, options, result: query } = capture();
      let paused = true;

      const { result, rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 1, { isPaused: () => paused, revalidateOnMount: false }),
      );
      expect(options().enabled).toBe(false);

      act(() => void result.current.mutate());

      expect(query.refetch).not.toHaveBeenCalled();
      // Armed, but `isPaused` still holds the request.
      expect(options().enabled).toBe(false);

      paused = false;
      rerender();

      expect(options().enabled).toBe(true);
    });

    it('reports a failed run to onError unless a newer run started', async () => {
      const { driver, options } = capture();
      const onError = vi.fn();
      const runs = [deferred<number>(), deferred<number>()];
      let call = 0;

      renderHook(() => driver.useQuery(['k'], () => runs[call++].promise, { onError }));
      const first = options().queryFn();
      const second = options().queryFn();

      runs[0].reject(new Error('stale'));
      runs[1].reject(new Error('latest'));
      await expect(first).rejects.toThrow('stale');
      await expect(second).rejects.toThrow('latest');

      expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('latest'));
    });
  });
});
