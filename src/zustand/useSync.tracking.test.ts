/**
 * @vitest-environment happy-dom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testDriver as driver } from '../../tests/testDriver';
import { defineReplica } from '../core/resource/defineReplica';
import { createReplica } from '../react/createReplica';
import { createMemoryStorage, resetScopeState, scope, setup, wrapper } from './testUtils';

beforeEach(resetScopeState);

/**
 * SWR re-renders a caller only for the fields it read. A `useSync` result that
 * reads `isValidating` eagerly subscribes every caller to each background
 * revalidation, so these tests pin that an unread field stays unsubscribed.
 */
describe('useSync dependency tracking', () => {
  it('does not re-render a caller that never reads isValidating on a revalidation', async () => {
    const { fetcher, slice } = setup();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        const sync = slice.useSync({ id: 'a' });
        void sync.error;
        return sync;
      },
      { wrapper },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    // Let the first request settle before taking the baseline.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const settled = renders;

    await act(async () => {
      await result.current.revalidate();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settled);
  });

  it('still shows isValidating going true → false to a caller that reads it', async () => {
    let resolveFetch!: (value: string[]) => void;
    const fetcher = vi.fn(() => new Promise<string[]>((resolve) => (resolveFetch = resolve)));
    const { slice } = setup({ fetcher });
    const seen: boolean[] = [];
    renderHook(
      () => {
        const sync = slice.useSync({ id: 'a' });
        seen.push(sync.isValidating);
        return sync;
      },
      { wrapper },
    );
    await waitFor(() => expect(seen).toContain(true));

    await act(async () => resolveFetch(['server']));

    await waitFor(() => expect(seen.at(-1)).toBe(false));
  });

  it('keeps useReplica callers off isValidating too', async () => {
    // One array for every response, so a refetch leaves `data` referentially
    // unchanged and only an `isValidating` subscription could re-render.
    const response = ['server a'];
    const fetcher = vi.fn(async (_params: { id: string }) => response);
    const replica = createReplica(
      defineReplica<{ id: string }, string[]>({
        fetcher,
        key: ({ id }) => id,
        name: 'trackedList',
        scope,
        storage: createMemoryStorage().storage,
        version: 1,
      }),
      { driver },
    );
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        const synced = replica.useReplica({ id: 'a' });
        void synced.data;
        return synced;
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(['server a']));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const settled = renders;

    await act(async () => {
      await result.current.revalidate();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settled);
  });
});
