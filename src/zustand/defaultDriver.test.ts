/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineReplica } from '../core/resource/defineReplica';
import { createReplica } from '../react/createReplica';
import { createDefaultDriver } from './defaultDriver';
import type { ReplicaQueryOptions } from './driver';
import { createMemoryStorage, resetScopeState, scope } from './testUtils';

beforeEach(resetScopeState);
afterEach(() => vi.restoreAllMocks());

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

/** Render one `useQuery` of a fresh driver; `props` may change the key and options. */
const mount = <T,>(
  initial: {
    fetcher?: () => Promise<T>;
    key?: readonly unknown[] | null;
    options?: ReplicaQueryOptions<T>;
  },
  driver = createDefaultDriver(),
) => {
  const fetcher = vi.fn(initial.fetcher ?? (async () => 'value' as T));
  const view = renderHook(
    ({ key, options }: { key: readonly unknown[] | null; options: ReplicaQueryOptions<T> }) =>
      driver.useQuery(key, fetcher, options),
    { initialProps: { key: initial.key === undefined ? ['k'] : initial.key, options: initial.options ?? {} } },
  );
  return { driver, fetcher, ...view };
};

const setVisibility = (state: DocumentVisibilityState) =>
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);

describe('createDefaultDriver', () => {
  describe('with createReplica', () => {
    it('paints the persisted row, then the server value, with no driver passed', async () => {
      const storage = createMemoryStorage();
      storage.rows.set('user-1:personal|a', { data: ['cached'], updatedAt: 1 });
      const request = deferred<string[]>();
      const resource = defineReplica<{ id: string }, string[]>({
        fetcher: () => request.promise,
        key: ({ id }) => id,
        name: 'defaultDriverList',
        scope,
        storage: storage.storage,
        version: 1,
      });
      const replica = createReplica(resource);
      // A second replica without a driver shares the same default one.
      createReplica({ ...resource, name: 'defaultDriverOther' });

      const { result } = renderHook(() => replica.useReplica({ id: 'a' }));

      await waitFor(() => expect(result.current.data).toEqual(['cached']));
      expect(result.current.isValidating).toBe(true);
      await act(async () => request.resolve(['server']));
      await waitFor(() => expect(result.current.data).toEqual(['server']));
      expect(result.current.isValidating).toBe(false);
      await waitFor(() => expect(storage.rows.get('user-1:personal|a')?.data).toEqual(['server']));
    });
  });

  describe('requests', () => {
    it('fetches on mount and reports the result to onSuccess', async () => {
      const onSuccess = vi.fn();
      const { fetcher, result } = mount({ options: { onSuccess } });

      expect(result.current.isValidating).toBe(true);
      await waitFor(() => expect(result.current.data).toBe('value'));
      expect(result.current.isValidating).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('value');
    });

    it('dedupes a second hook of the key within the window, and reports to the starter only', async () => {
      const driver = createDefaultDriver();
      const fetcher = vi.fn(async () => 'value');
      const first = vi.fn();
      const second = vi.fn();

      renderHook(() => driver.useQuery(['k'], fetcher, { onSuccess: first }));
      const joined = renderHook(() => driver.useQuery(['k'], fetcher, { onSuccess: second }));

      await waitFor(() => expect(joined.result.current.data).toBe('value'));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();

      // Past the window (0 here), a mount fetches again.
      renderHook(() => driver.useQuery(['k'], fetcher, { dedupingInterval: 0 }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    });

    it('joins a settled request while the window is open', async () => {
      const driver = createDefaultDriver();
      const fetcher = vi.fn(async () => 'value');
      const { result } = renderHook(() => driver.useQuery(['k'], fetcher, {}));
      await waitFor(() => expect(result.current.data).toBe('value'));

      const again = renderHook(() => driver.useQuery(['k'], fetcher, {}));

      expect(again.result.current.data).toBe('value');
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('reports only the latest request after mutate replaced one in flight', async () => {
      const runs = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()];
      let call = 0;
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const { result } = mount({
        fetcher: () => runs[call++].promise,
        options: { onError, onSuccess },
      });

      void act(() => void result.current.mutate());
      await act(async () => runs[1].resolve('newer'));
      await act(async () => runs[0].resolve('older'));

      expect(result.current.data).toBe('newer');
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('newer');

      // A replaced request that fails reports nothing either.
      void act(() => void result.current.mutate());
      void act(() => void result.current.mutate());
      await act(async () => runs[3].resolve('latest'));
      await act(async () => runs[2].reject(new Error('stale')));
      expect(result.current.error).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    });

    it('reports a failure, keeps the last data, and resolves mutate', async () => {
      const failure = new Error('offline');
      let fail = false;
      const onError = vi.fn();
      const { result } = mount({
        fetcher: vi.fn(async () => {
          if (fail) throw failure;
          return 'value';
        }),
        options: { onError },
      });
      await waitFor(() => expect(result.current.data).toBe('value'));

      fail = true;
      await act(async () => {
        await expect(result.current.mutate()).resolves.toBeUndefined();
      });

      expect(result.current.error).toBe(failure);
      expect(result.current.data).toBe('value');
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    });

    it('turns a fetcher that throws synchronously into a failure', async () => {
      const failure = new Error('sync');
      const { result } = mount({
        fetcher: () => {
          throw failure;
        },
      });

      await waitFor(() => expect(result.current.error).toBe(failure));
    });

    it('does nothing without a key', async () => {
      const { fetcher, result } = mount({ key: null });

      expect(result.current).toMatchObject({ data: undefined, isValidating: false });
      await expect(result.current.mutate()).resolves.toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('schedule', () => {
    it('keeps a cached result for once and revalidateIfStale: false, which seed provides', async () => {
      const driver = createDefaultDriver();
      const once = vi.fn(async () => true);
      const first = renderHook(() =>
        driver.useQuery(['hydrate'], once, { dedupingInterval: 0, once: true }),
      );
      await waitFor(() => expect(first.result.current.data).toBe(true));
      first.unmount();

      renderHook(() => driver.useQuery(['hydrate'], once, { dedupingInterval: 0, once: true }));
      expect(once).toHaveBeenCalledOnce();

      driver.seed!(['seeded'], 'from fetch');
      const fetcher = vi.fn(async () => 'network');
      const { result } = renderHook(() =>
        driver.useQuery(['seeded'], fetcher, { revalidateIfStale: false }),
      );
      expect(result.current.data).toBe('from fetch');
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('holds the first key with revalidateOnMount: false until mutate, but not a later key', async () => {
      const { fetcher, rerender, result } = mount({ options: { revalidateOnMount: false } });
      await act(async () => undefined);
      expect(fetcher).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.mutate();
      });
      expect(fetcher).toHaveBeenCalledOnce();

      rerender({ key: ['other'], options: { revalidateOnMount: false } });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    });

    it('holds every request while isPaused', async () => {
      let paused = true;
      const { driver, fetcher, result } = mount({ options: { isPaused: () => paused } });
      await act(async () => undefined);

      await act(async () => {
        await result.current.mutate();
        await driver.revalidate(() => true);
      });
      expect(fetcher).not.toHaveBeenCalled();

      paused = false;
      await act(async () => {
        await result.current.mutate();
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  describe('revalidate', () => {
    it('re-runs the mounted keys that match, replacing a request in flight', async () => {
      const driver = createDefaultDriver();
      const a = vi.fn(async () => 'a');
      const b = vi.fn(async () => 'b');
      const gone = vi.fn(async () => 'gone');
      renderHook(() => driver.useQuery(['a'], a, {}));
      renderHook(() => driver.useQuery(['b'], b, {}));
      renderHook(() => driver.useQuery(['gone'], gone, {})).unmount();

      await act(async () => {
        await driver.revalidate((key) => (key as string[])[0] !== 'b');
      });

      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledOnce();
      expect(gone).toHaveBeenCalledOnce();
    });
  });

  describe('callbacks', () => {
    it('stops reporting after unmount and after a key switch, but not when the key turns null', async () => {
      const runs = [deferred<string>(), deferred<string>(), deferred<string>()];
      let call = 0;
      const onSuccess = vi.fn();
      const options = { onSuccess };
      const view = mount({ fetcher: () => runs[call++].promise, options });

      // The key turns null while its request is in flight: SWR still reports it.
      view.rerender({ key: null, options });
      await act(async () => runs[0].resolve('kept'));
      expect(onSuccess).toHaveBeenCalledExactlyOnceWith('kept');

      // A switch to another key: the request of the key left behind reports nothing.
      view.rerender({ key: ['k'], options: { ...options, dedupingInterval: 0 } } as never);
      view.rerender({ key: ['next'], options });
      await act(async () => runs[1].resolve('left'));
      expect(onSuccess).toHaveBeenCalledOnce();

      view.unmount();
      await act(async () => runs[2].resolve('late'));
      expect(onSuccess).toHaveBeenCalledOnce();
    });
    it('does not report a failure that lands after unmount', async () => {
      const request = deferred<string>();
      const onError = vi.fn();
      const { result, unmount } = mount({ fetcher: () => request.promise, options: { onError } });
      expect(result.current.isValidating).toBe(true);

      unmount();
      await act(async () => request.reject(new Error('late')));

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('polls while shown, skips a hidden or offline page unless allowed, and stops at 0', async () => {
      const { fetcher, rerender } = mount({ options: { dedupingInterval: 0, refreshInterval: 10 } });
      await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3));

      const hidden = setVisibility('hidden');
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      const whileHidden = fetcher.mock.calls.length;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
      expect(fetcher.mock.calls.length).toBe(whileHidden);

      rerender({ key: ['k'], options: { dedupingInterval: 0, refreshInterval: 10, refreshWhenHidden: true } });
      await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(whileHidden));
      hidden.mockRestore();

      const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
      const whileOffline = fetcher.mock.calls.length;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
      expect(fetcher.mock.calls.length).toBe(whileOffline);
      offline.mockRestore();

      // A function interval reads the latest data; 0 stops the loop.
      const interval = vi.fn(() => 0);
      rerender({ key: ['k'], options: { dedupingInterval: 0, refreshInterval: interval } });
      await waitFor(() => expect(interval).toHaveBeenCalled());
      const stopped = fetcher.mock.calls.length;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
      expect(fetcher.mock.calls.length).toBe(stopped);
    });

    it('keeps polling offline with refreshWhenOffline', async () => {
      const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const { fetcher } = mount({
        options: { dedupingInterval: 0, refreshInterval: 10, refreshWhenOffline: true },
      });

      await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3));
      offline.mockRestore();
    });
  });

  describe('focus and reconnect', () => {
    it('revalidates on focus, throttled, and on reconnect, as the schedule allows', async () => {
      const driver = createDefaultDriver();
      const fetcher = vi.fn(async () => 'value');
      const optedOut = vi.fn(async () => 'value');
      const pinned = vi.fn(async () => true);
      renderHook(() =>
        driver.useQuery(['k'], fetcher, { dedupingInterval: 0, focusThrottleInterval: 60_000 }),
      );
      renderHook(() =>
        driver.useQuery(['off'], optedOut, {
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }),
      );
      renderHook(() => driver.useQuery(['once'], pinned, { dedupingInterval: 0, once: true }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

      act(() => void window.dispatchEvent(new Event('focus')));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      // Within the throttle window: no second focus revalidation.
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      act(() => void window.dispatchEvent(new Event('online')));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));

      expect(optedOut).toHaveBeenCalledOnce();
      expect(pinned).toHaveBeenCalledOnce();
    });

    it('ignores a visibility change to hidden, and stops listening once nothing is mounted', async () => {
      const driver = createDefaultDriver();
      const fetcher = vi.fn(async () => 'value');
      const remove = vi.spyOn(window, 'removeEventListener');
      const { unmount } = renderHook(() =>
        driver.useQuery(['k'], fetcher, { dedupingInterval: 0, focusThrottleInterval: 0 }),
      );
      await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

      const hidden = setVisibility('hidden');
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      hidden.mockRestore();
      expect(fetcher).toHaveBeenCalledOnce();

      unmount();
      expect(remove).toHaveBeenCalledWith('focus', expect.any(Function));
      act(() => void window.dispatchEvent(new Event('focus')));
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });
});
