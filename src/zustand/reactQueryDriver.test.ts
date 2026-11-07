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

/**
 * Two replicas over one `QueryClient`: their sync queries share one cache
 * entry, so only one of them runs the fetch.
 */
const sharedSetup = (
  fetcher = vi.fn(async ({ id }: { id: string }) => [`server ${id}`]),
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const resourceOf = () =>
    defineReplica<{ id: string }, string[]>({
      fetcher,
      key: ({ id }) => id,
      name: 'rqShared',
      scope,
      storage: createMemoryStorage().storage,
      version: 1,
    });
  const driver = () => createReactQueryDriver({ queryClient, useQuery });
  return {
    fetcher,
    first: createReplica(resourceOf(), { driver: driver() }),
    second: createReplica(resourceOf(), { driver: driver() }),
    wrapper: ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
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

  it('fetches a key the hook switches to after mounting with revalidateOnMount: false', async () => {
    const { fetcher, replica, wrapper } = setup();

    // The mount hold belongs to the key the hook mounted with: the key it moves
    // to was never requested, so it fetches like any other mount.
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => replica.useReplica({ id }, { revalidateOnMount: false }),
      { initialProps: { id: 'a' }, wrapper },
    );
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ id: 'b' });

    await waitFor(() => expect(result.current.data).toEqual(['server b']));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ id: 'b' }, undefined);
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

  it('moves the pause to the new key when the key changes while paused', async () => {
    const { fetcher, replica, wrapper } = setup();
    let paused = true;

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => replica.useReplica({ id }, { isPaused: () => paused }),
      { initialProps: { id: 'a' }, wrapper },
    );
    rerender({ id: 'b' });
    expect(fetcher).not.toHaveBeenCalled();

    paused = false;
    rerender({ id: 'b' });

    await waitFor(() => expect(result.current.data).toEqual(['server b']));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ id: 'b' }, undefined);
  });

  it('releases the pause left behind by an unmounted hook', async () => {
    const { fetcher, replica, wrapper } = setup();
    const paused = renderHook(() => replica.useReplica({ id: 'a' }, { isPaused: () => true }), {
      wrapper,
    });
    await waitFor(() => expect(paused.result.current.isHydrated).toBe(true));
    paused.unmount();

    const live = renderHook(() => replica.useReplica({ id: 'a' }), { wrapper });

    await waitFor(() => expect(live.result.current.data).toEqual(['server a']));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith({ id: 'a' }, undefined);
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

  it('encodes an absent seed as null, the value the query function stores', () => {
    const { queryClient } = setup();
    const driver = createReactQueryDriver({ queryClient, useQuery });

    driver.seed!(['k'], undefined);

    // `setQueryData` ignores `undefined`: the cache would stay on the previous
    // value and a hook showing the key would keep what the server no longer has.
    expect(queryClient.getQueryData(['k'])).toBeNull();
  });

  it('does not settle a seeded response a second time in the replica that fetched it', async () => {
    const { replica, wrapper } = setup();
    const onSuccess = vi.fn();

    const { result } = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess }), {
      wrapper,
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith(['server a']));

    // An idle key: `fetch` applies the response to the slice itself and then
    // seeds the cache. The seed publishes another settlement of the same
    // response, which the hook must not fold — that would settle twice.
    await act(async () => {
      await replica.fetch({ id: 'a' });
    });
    await waitFor(() => expect(result.current.data).toEqual(['server a']));

    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(['server a']);
  });

  it('judges a replaced fetch by its own start after the observing replica dropped the key', async () => {
    const requests: { promise: Promise<string[]>; resolve: (value: string[]) => void }[] = [];
    const fetcher = vi.fn(() => {
      const next = deferred<string[]>();
      requests.push(next);
      return next.promise;
    });
    const { first, second, wrapper } = sharedSetup(fetcher);

    // The executing replica paints the first value; the observing one shares it.
    renderHook(() => first.useReplica({ id: 'a' }, {}), { wrapper });
    await act(async () => requests[0].resolve(['first']));
    const seen = vi.fn();
    const { result } = renderHook(
      () => second.useReplica({ id: 'a' }, { onSuccess: seen, revalidateIfStale: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(['first']));

    // A background fetch starts on the shared key, then this replica drops the
    // entry under it, then it revalidates and replaces that fetch in flight.
    await act(async () => {
      void first.revalidate('a');
    });
    await act(async () => {
      void second.clear();
    });
    // The gate compares wall-clock stamps: a request that starts in the same
    // millisecond as the clear is on neither side of it, so give the drop its own.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await act(async () => {
      void second.revalidate('a');
    });

    const last = requests[requests.length - 1];
    await act(async () => last.resolve(['after drop']));

    await waitFor(() => expect(result.current.data).toEqual(['after drop']));
    expect(seen).toHaveBeenLastCalledWith(['after drop']);
  });

  it('judges a settlement a later fetch produced by that fetch, not an earlier replacement', async () => {
    const requests: { promise: Promise<string[]>; resolve: (value: string[]) => void }[] = [];
    const fetcher = vi.fn(() => {
      const next = deferred<string[]>();
      requests.push(next);
      return next.promise;
    });
    const { first, second, wrapper } = sharedSetup(fetcher);

    renderHook(() => first.useReplica({ id: 'a' }, {}), { wrapper });
    await act(async () => requests[0].resolve(['first']));
    const seen = vi.fn();
    const { result } = renderHook(
      () => second.useReplica({ id: 'a' }, { onSuccess: seen, revalidateIfStale: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(['first']));

    // A revalidate replaces the fetch in flight and records when its replacement
    // started — before this replica drops the entry.
    await act(async () => {
      void first.revalidate('a');
    });
    await act(async () => requests[1].resolve(['replaced']));
    await waitFor(() => expect(result.current.data).toEqual(['replaced']));

    await act(async () => {
      void second.clear();
    });
    // The gate compares wall-clock stamps: a fetch that starts in the same
    // millisecond as the clear is neither side of it, so give the drop its own.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    // A later fetch starts after the drop and settles on its own. The recorded
    // start belongs to the request above; judging this settlement by it would
    // refuse a response the drop never saw and leave the view stale.
    await act(async () => {
      void first.fetch({ id: 'a' });
    });
    await act(async () => requests[2].resolve(['after drop']));

    await waitFor(() => expect(result.current.data).toEqual(['after drop']));
    expect(seen).toHaveBeenLastCalledWith(['after drop']);
  });

  it('settles a hook whose replica shares the query a second instance fetched', async () => {
    const { fetcher, first, second, wrapper } = sharedSetup();

    const firstDone = vi.fn();
    const { result: a } = renderHook(
      () => first.useReplica({ id: 'a' }, { onSuccess: firstDone }),
      { wrapper },
    );
    await waitFor(() => expect(a.current.data).toEqual(['server a']));
    expect(firstDone).toHaveBeenCalledExactlyOnceWith(['server a']);

    // The second replica shares the client, so its query joins the first one's
    // fetch instead of running its own: it still has to settle on the result.
    const secondDone = vi.fn();
    const { result: b } = renderHook(
      () => second.useReplica({ id: 'a' }, { onSuccess: secondDone, revalidateIfStale: false }),
      { wrapper },
    );

    await waitFor(() => expect(b.current.data).toEqual(['server a']));
    expect(secondDone).toHaveBeenCalledExactlyOnceWith(['server a']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('settles a hook on a result another replica fetched after its own run', async () => {
    const { first, second, wrapper } = sharedSetup();

    const firstDone = vi.fn();
    renderHook(() => first.useReplica({ id: 'a' }, { onSuccess: firstDone }), { wrapper });
    await waitFor(() => expect(firstDone).toHaveBeenCalledExactlyOnceWith(['server a']));

    // The second replica joins the shared key. Its later refetch changes the
    // settlement, and the first hook's own run is long done: it has to settle
    // on the newer result instead of resting on the one it fetched.
    const secondDone = vi.fn();
    renderHook(
      () => second.useReplica({ id: 'a' }, { onSuccess: secondDone, revalidateIfStale: false }),
      { wrapper },
    );
    await waitFor(() => expect(secondDone).toHaveBeenCalledExactlyOnceWith(['server a']));

    await act(async () => {
      await second.revalidate('a');
    });

    await waitFor(() => expect(firstDone).toHaveBeenCalledTimes(2));
    expect(firstDone).toHaveBeenLastCalledWith(['server a']);
  });

  it('reports a shared key once when two hooks of one replica mount together', async () => {
    const { fetcher, replica, wrapper } = setup();
    const first = vi.fn();
    const second = vi.fn();

    renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: first }), { wrapper });
    renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: second }), { wrapper });

    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(['server a']));
    expect(second).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('settles a hook on a shared failure the other replica query hit', async () => {
    const request = deferred<string[]>();
    const failure = new Error('offline');
    const { fetcher, first, second, wrapper } = sharedSetup(vi.fn(() => request.promise));

    const firstError = vi.fn();
    renderHook(() => first.useReplica({ id: 'a' }, { onError: firstError }), { wrapper });
    // The second replica joins the key while the fetch is still in flight, so
    // TanStack dedupes it and only the first hook's `queryFn` runs — and so only
    // its `onError` would run. The failure is on screen for both.
    const secondError = vi.fn();
    renderHook(() => second.useReplica({ id: 'a' }, { onError: secondError }), { wrapper });

    await act(async () => request.reject(failure));

    await waitFor(() => expect(firstError).toHaveBeenCalledTimes(1));
    expect(firstError).toHaveBeenCalledWith(failure, expect.objectContaining({ key: 'a' }));
    await waitFor(() => expect(secondError).toHaveBeenCalledTimes(1));
    expect(secondError).toHaveBeenCalledWith(failure, expect.objectContaining({ key: 'a' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('settles a hook on a success that followed its own failed run', async () => {
    const failure = new Error('offline');
    const fetcher = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(['server a']);
    const { first, second, wrapper } = sharedSetup(fetcher);

    const firstError = vi.fn();
    const firstDone = vi.fn();
    const { result: a } = renderHook(
      () => first.useReplica({ id: 'a' }, { onError: firstError, onSuccess: firstDone }),
      { wrapper },
    );
    await waitFor(() => expect(firstError).toHaveBeenCalledTimes(1));
    expect(a.current.data).toBeUndefined();

    // The second replica retries the shared key and the query succeeds. The
    // first hook's own run already ended in the failure above, so the success
    // is not its own reported one: it has to settle on it instead of waiting
    // for a run that already failed.
    const secondDone = vi.fn();
    renderHook(() => second.useReplica({ id: 'a' }, { onSuccess: secondDone }), { wrapper });

    await waitFor(() => expect(firstDone).toHaveBeenCalledWith(['server a']));
    expect(secondDone).toHaveBeenCalledWith(['server a']);
    await waitFor(() => expect(a.current.data).toEqual(['server a']));
  });

  it('keeps the ownership of a run the hook left behind when it fails', async () => {
    const requestA = deferred<string[]>();
    const requestB = deferred<string[]>();
    const fetcher = vi.fn(({ id }: { id: string }) =>
      id === 'a' ? requestA.promise : requestB.promise,
    );
    const { replica, wrapper } = setup(fetcher);

    const done = vi.fn();
    const { rerender, result } = renderHook(
      ({ id }: { id: string }) => replica.useReplica({ id }, { onSuccess: done }),
      { initialProps: { id: 'a' }, wrapper },
    );

    // The hook switches keys while A is still in flight, so B's run owns the
    // success-delivery flag from here on.
    rerender({ id: 'b' });

    // A rejects after it lost the key: the failure is not this hook's to
    // report, and handing the ownership back would let B's success be folded
    // twice — once from its query function, once from the cache watch.
    await act(async () => requestA.reject(new Error('late')));
    await act(async () => requestB.resolve(['server b']));

    await waitFor(() => expect(result.current.data).toEqual(['server b']));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(['server b']);
  });

  it('clears the error ownership a failed attempt left when a retry succeeds', async () => {
    const firstFailure = new Error('offline');
    const laterFailure = new Error('server gone');
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(['server a'])
      .mockRejectedValue(laterFailure);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: 1, retryDelay: 0 } },
    });
    const resourceOf = () =>
      defineReplica<{ id: string }, string[]>({
        fetcher,
        key: ({ id }) => id,
        name: 'rqRetried',
        scope,
        storage: createMemoryStorage().storage,
        version: 1,
      });
    const driver = () => createReactQueryDriver({ queryClient, useQuery });
    const first = createReplica(resourceOf(), { driver: driver() });
    const second = createReplica(resourceOf(), { driver: driver() });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const onError = vi.fn();
    const { result } = renderHook(() => first.useReplica({ id: 'a' }, { onError }), { wrapper });

    // The first attempt fails, TanStack retries, and the retry succeeds: no
    // failure settlement is ever published for this run.
    await waitFor(() => expect(result.current.data).toEqual(['server a']));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(firstFailure);

    // Another replica now fetches the shared key and fails. That failure is a
    // new settlement this hook never reported, so it has to deliver it — the
    // failed attempt above left nothing behind for it to consume.
    const { result: b } = renderHook(
      () => second.useReplica({ id: 'a' }, { revalidateOnMount: false }),
      { wrapper },
    );
    await waitFor(() => expect(b.current.data).toEqual(['server a']));
    await act(async () => {
      await second.revalidate('a').catch(() => undefined);
    });

    await waitFor(() =>
      expect(onError.mock.calls.some(([error]) => error === laterFailure)).toBe(true),
    );
  });

  it('does not replay a failure the query has since recovered from', async () => {
    const failure = new Error('offline');
    const fetcher = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(['server a']);
    const { first, second, wrapper } = sharedSetup(fetcher);

    const firstError = vi.fn();
    const { result } = renderHook(() => first.useReplica({ id: 'a' }, { onError: firstError }), {
      wrapper,
    });
    await waitFor(() => expect(firstError).toHaveBeenCalledExactlyOnceWith(failure, expect.anything()));
    expect(result.current.error).toEqual(failure);

    // A later run succeeds. TanStack clears `error` but keeps `errorUpdatedAt`,
    // so the cached entry still carries the timestamp of a failure nobody is in.
    await act(async () => {
      await first.revalidate('a');
    });
    await waitFor(() => expect(result.current.error).toBeUndefined());

    // A replica with a fresh delivery map mounts on that recovered cache: it has
    // to settle the cached success and stay quiet about the historical failure.
    const secondError = vi.fn();
    const { result: secondResult } = renderHook(
      () => second.useReplica({ id: 'a' }, { onError: secondError, revalidateIfStale: false }),
      { wrapper },
    );

    await waitFor(() => expect(secondResult.current.data).toEqual(['server a']));
    expect(secondError).not.toHaveBeenCalled();
  });

  it('reports a shared failure once when two hooks of one replica await it', async () => {
    const request = deferred<string[]>();
    const failure = new Error('offline');
    const { replica, wrapper } = setup(vi.fn(() => request.promise));
    const first = vi.fn();
    const second = vi.fn();

    renderHook(() => replica.useReplica({ id: 'a' }, { onError: first }), { wrapper });
    renderHook(() => replica.useReplica({ id: 'a' }, { onError: second }), { wrapper });

    await act(async () => request.reject(failure));

    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps the delivery memory while another hook still shows the key', async () => {
    const { fetcher, replica, wrapper } = setup();
    const first = vi.fn();
    const second = vi.fn();

    const firstHook = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: first }), {
      wrapper,
    });
    renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: second }), { wrapper });

    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(['server a']));
    expect(second).not.toHaveBeenCalled();

    // One hook leaves, the key is still on screen: the settlement it reported is
    // still the one this activation delivered, so the remaining hook folds
    // nothing and the key is not refetched.
    firstHook.unmount();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('replays a cached result to the next hook after the key was left', async () => {
    const { fetcher, replica, wrapper } = setup();
    const first = vi.fn();
    const firstHook = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: first }), {
      wrapper,
    });
    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(['server a']));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The view that held `a` goes away (an unmount, or a scope reset that
    // clears the same entries): its delivery is no longer on screen.
    firstHook.unmount();

    // The key comes back with the result still cached. `revalidateIfStale:
    // false` does not refetch it, so the new hook has to settle on the cached
    // value — otherwise the key shows nothing while its query succeeded.
    const second = vi.fn();
    renderHook(
      () => replica.useReplica({ id: 'a' }, { onSuccess: second, revalidateIfStale: false }),
      { wrapper },
    );
    await waitFor(() => expect(second).toHaveBeenCalledExactlyOnceWith(['server a']));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('does not replay a value the replica removed after caching it', async () => {
    const { fetcher, replica, wrapper } = setup();
    const first = vi.fn();
    const firstHook = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: first }), {
      wrapper,
    });
    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(['server a']));

    // The entry is gone: the view and the persisted row are dropped, but the
    // query cache still holds the value.
    firstHook.unmount();
    act(() => void replica.remove('a'));

    // `revalidateIfStale: false` does not refetch, so replaying the cached value
    // here would put the removed entry straight back on screen.
    const second = vi.fn();
    const { result } = renderHook(
      () => replica.useReplica({ id: 'a' }, { onSuccess: second, revalidateIfStale: false }),
      { wrapper },
    );
    await Promise.resolve();

    expect(second).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not replay a value from a scope cleared after caching it', async () => {
    const { replica, wrapper } = setup();
    const first = vi.fn();
    const firstHook = renderHook(() => replica.useReplica({ id: 'a' }, { onSuccess: first }), {
      wrapper,
    });
    await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(['server a']));

    firstHook.unmount();
    await act(async () => void (await replica.clear()));

    const second = vi.fn();
    const { result } = renderHook(
      () => replica.useReplica({ id: 'a' }, { onSuccess: second, revalidateIfStale: false }),
      { wrapper },
    );
    await Promise.resolve();

    expect(second).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('settles a cached result as the undefined the fetcher returned', async () => {
    const { first, second, wrapper } = sharedSetup(
      vi.fn(async (_: { id: string }) => undefined as unknown as string[]),
    );

    const firstDone = vi.fn();
    renderHook(() => first.useReplica({ id: 'a' }, { onSuccess: firstDone }), { wrapper });
    await waitFor(() => expect(firstDone).toHaveBeenCalledExactlyOnceWith(undefined));

    const secondDone = vi.fn();
    renderHook(
      () => second.useReplica({ id: 'a' }, { onSuccess: secondDone, revalidateIfStale: false }),
      { wrapper },
    );
    await waitFor(() => expect(secondDone).toHaveBeenCalledExactlyOnceWith(undefined));
  });

  describe('options', () => {
    const capture = () => {
      const result = {
        data: undefined as unknown,
        // Absent until a test says the fake hook holds a settlement.
        dataUpdateCount: undefined as number | undefined,
        dataUpdatedAt: undefined as number | undefined,
        error: null as unknown,
        errorUpdateCount: undefined as number | undefined,
        errorUpdatedAt: undefined as number | undefined,
        isFetching: false,
        refetch: vi.fn(),
      };
      const useQueryHook = vi.fn<ReactQueryLikeHook>(() => result);
      const client = new QueryClient();
      const driver = createReactQueryDriver({ queryClient: client, useQuery: useQueryHook });
      return { client, driver, options: () => useQueryHook.mock.lastCall![0], result };
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
      const { driver, options, result: query } = capture();

      const { result } = renderHook(() => driver.useQuery(null, async () => 1, {}));

      expect(options()).toMatchObject({ enabled: false, queryKey: ['local-replica', 'disabled'] });
      expect(result.current.error).toBeUndefined();

      // A manual refetch would run the fetcher with the null params it was given.
      act(() => void result.current.mutate());
      expect(query.refetch).not.toHaveBeenCalled();
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

    it('settles on the cached value, not on one an observer selected', () => {
      const { client, driver, result: query } = capture();
      const onSuccess = vi.fn();
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', { onSuccess }),
      );

      // A default `select` on this key: the observer's `data` is the selected
      // value, while the cache keeps what the fetcher returned.
      client.setQueryData(['k'], { items: ['a'] });
      query.data = ['a'];
      query.dataUpdatedAt = 1;
      rerender();

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith({ items: ['a'] });
    });

    it('replays a cached settlement when the replica reports no drop', () => {
      const { driver, result: query } = capture();
      const onSuccess = vi.fn();
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', { onSuccess }),
      );

      // A result this hook did not fetch, already in the cache: nothing says the
      // replica dropped it, so the hook settles on it.
      query.data = 'cached';
      query.dataUpdatedAt = 1;
      rerender();

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('cached');
    });

    it('holds a cached settlement back when the replica reports a drop', () => {
      const { driver, result: query } = capture();
      const onSuccess = vi.fn();
      let dropped = true;
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', { onSuccess, replayable: () => !dropped }),
      );

      query.data = 'cached';
      query.dataUpdatedAt = 1;
      rerender();
      expect(onSuccess).not.toHaveBeenCalled();

      // A value settled after the drop is a real response, not the dropped one.
      dropped = false;
      query.dataUpdatedAt = 2;
      rerender();

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('cached');
    });

    it('holds back a cached settlement whose request started before the drop', () => {
      const { driver, result: query } = capture();
      const onSuccess = vi.fn();
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let droppedAt = 0;
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', {
          onSuccess,
          replayable: (settledAt) => settledAt > droppedAt,
        }),
      );

      // A shared request leaves: this hook did not fetch it, but it sees it go.
      now = 1100;
      query.isFetching = true;
      rerender();

      // The replica drops the entry while that request is still in flight.
      now = 2000;
      droppedAt = now;

      // It completes after the drop, so its completion timestamp says nothing
      // about which side of the drop its response was computed on.
      now = 3000;
      query.isFetching = false;
      query.data = 'before the drop';
      query.dataUpdatedAt = 3000;
      rerender();
      expect(onSuccess).not.toHaveBeenCalled();

      // A request that starts after the drop is a real response.
      now = 4000;
      query.isFetching = true;
      rerender();
      now = 5000;
      query.isFetching = false;
      query.data = 'after the drop';
      query.dataUpdateCount = 2;
      query.dataUpdatedAt = 5000;
      rerender();

      clock.mockRestore();

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('after the drop');
    });

    it('judges a key the hook switches to by that key\'s own request start', () => {
      const { driver, result: query } = capture();
      const onSuccess = vi.fn();
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const droppedAt = 1500;
      const { rerender } = renderHook(
        ({ key }: { key: string[] }) =>
          driver.useQuery(key, async () => 'server', {
            onSuccess,
            replayable: (settledAt) => settledAt > droppedAt,
          }),
        { initialProps: { key: ['a'] } },
      );

      // A request over `a` leaves, and this hook watches it go.
      query.isFetching = true;
      rerender({ key: ['a'] });

      // The replica drops the shared entries, then the hook switches to `b`,
      // which is already fetching: `b`'s request started after the drop, so
      // the start of `a`'s request must not be the one it is judged by.
      now = 2000;
      rerender({ key: ['b'] });

      now = 3000;
      query.isFetching = false;
      query.data = 'b after the drop';
      query.dataUpdateCount = 1;
      query.dataUpdatedAt = 3000;
      rerender({ key: ['b'] });

      clock.mockRestore();

      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('b after the drop');
    });

    it('tracks one key written in another property order as one identity', () => {
      const { driver, result: query } = capture();
      const firstDone = vi.fn();
      const secondDone = vi.fn();
      const { rerender } = renderHook(() => {
        driver.useQuery(['k', { page: 1, id: 'a' }], async () => 'server', {
          onSuccess: firstDone,
        });
        driver.useQuery(['k', { id: 'a', page: 1 }], async () => 'server', {
          onSuccess: secondDone,
        });
      });

      // TanStack dedupes those two keys into one query, so the settlement is
      // one settlement: the second hook must read the delivery the first one
      // recorded instead of folding it again under a hash of its own.
      query.data = 'cached';
      query.dataUpdateCount = 1;
      query.dataUpdatedAt = 1;
      rerender();

      expect(firstDone).toHaveBeenCalledExactlyOnceWith('cached');
      expect(secondDone).not.toHaveBeenCalled();
    });

    it('holds back a failure whose request started before the drop', () => {
      const { driver, result: query } = capture();
      const onError = vi.fn();
      const beforeDrop = new Error('before the drop');
      const afterDrop = new Error('after the drop');
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let droppedAt = 0;
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', {
          onError,
          replayable: (settledAt) => settledAt > droppedAt,
        }),
      );

      // A shared request leaves: this hook did not fetch it, but it sees it go.
      now = 1100;
      query.isFetching = true;
      rerender();

      // The replica drops the entry while that request is still in flight.
      now = 2000;
      droppedAt = now;

      // It fails after the drop, so the failure is pre-drop work: folding it
      // would run the recovery effects of a generation that never asked.
      now = 3000;
      query.isFetching = false;
      query.error = beforeDrop;
      query.errorUpdateCount = 1;
      query.errorUpdatedAt = 3000;
      rerender();
      expect(onError).not.toHaveBeenCalled();

      // A request that starts after the drop is a real failure.
      now = 4000;
      query.isFetching = true;
      rerender();
      now = 5000;
      query.isFetching = false;
      query.error = afterDrop;
      query.errorUpdateCount = 2;
      query.errorUpdatedAt = 5000;
      rerender();

      clock.mockRestore();

      expect(onError).toHaveBeenCalledExactlyOnceWith(afterDrop);
    });

    it('settles a second value that shares the first settlement timestamp', () => {
      const { driver, result: query } = capture();
      const onSuccess = vi.fn();
      const { rerender } = renderHook(() =>
        driver.useQuery(['k'], async () => 'server', { onSuccess }),
      );

      // Two updates in one millisecond: TanStack stamps both with the same
      // `dataUpdatedAt`, so the timestamp alone cannot tell them apart.
      query.data = 'first';
      query.dataUpdatedAt = 1;
      query.dataUpdateCount = 1;
      rerender();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('first');

      query.data = 'second';
      query.dataUpdatedAt = 1;
      query.dataUpdateCount = 2;
      rerender();

      expect(onSuccess).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenLastCalledWith('second');
    });

    it('settles a second failure that shares the first settlement timestamp', () => {
      const { driver, result: query } = capture();
      const onError = vi.fn();
      const { rerender } = renderHook(() => driver.useQuery(['k'], async () => 'server', { onError }));

      query.error = new Error('first');
      query.errorUpdatedAt = 1;
      query.errorUpdateCount = 1;
      rerender();
      expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('first'));

      query.error = new Error('second');
      query.errorUpdatedAt = 1;
      query.errorUpdateCount = 2;
      rerender();

      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenLastCalledWith(new Error('second'));
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
