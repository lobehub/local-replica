import { describe, expect, it, vi } from 'vitest';

import { createSWRDriver } from './driver';

const swrResult = { isValidating: false, mutate: vi.fn(async () => undefined) };

describe('createSWRDriver', () => {
  it('revalidates by handing the matcher straight to `mutate`', async () => {
    const mutate = vi.fn(async () => undefined);
    const driver = createSWRDriver({ mutate, useSWR: vi.fn(() => swrResult) });
    const match = (key: unknown) => key === 'a';

    await driver.revalidate(match);

    expect(mutate).toHaveBeenCalledExactlyOnceWith(match);
  });

  it('seeds without revalidating, and swallows a rejected cache write', async () => {
    const mutate = vi.fn(async () => {
      throw new Error('cache gone');
    });
    const driver = createSWRDriver({ mutate, useSWR: vi.fn(() => swrResult) });

    expect(() => driver.seed!(['k'], ['data'])).not.toThrow();
    // Let the rejection settle: an unhandled one would fail the run.
    await Promise.resolve();

    expect(mutate).toHaveBeenCalledExactlyOnceWith(['k'], ['data'], { revalidate: false });
  });

  it('passes only the schedule options that are set, and freezes a `once` query', () => {
    const useSWR = vi.fn((_key: unknown, _fetcher: unknown, _config?: any) => swrResult);
    const driver = createSWRDriver({ mutate: vi.fn(), useSWR });
    const fetcher = async () => 1;

    driver.useQuery(['k'], fetcher, {
      once: true,
      refreshInterval: 5000,
      revalidateOnFocus: undefined,
    });

    const [key, passedFetcher, config] = useSWR.mock.calls[0];
    expect(key).toEqual(['k']);
    expect(passedFetcher).toBe(fetcher);
    expect(config).toEqual({
      refreshInterval: 5000,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    });
  });

  it('forwards SWR success and error callbacks to the query callbacks', () => {
    const useSWR = vi.fn((_key: unknown, _fetcher: unknown, _config?: any) => swrResult);
    const driver = createSWRDriver({ mutate: vi.fn(), useSWR });
    const onError = vi.fn();
    const onSuccess = vi.fn();

    driver.useQuery(['k'], async () => 1, { onError, onSuccess });

    const config = useSWR.mock.calls[0][2];
    expect(config).not.toHaveProperty('revalidateIfStale');
    const failure = new Error('boom');
    config.onError(failure);
    config.onSuccess(42);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(42);
  });
});
