/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_REMOVAL_TOMBSTONE_LIMIT } from '../core/engine/tombstones';
import { resetScopeState, setup } from './testUtils';

beforeEach(resetScopeState);

describe('request retirement', () => {
  // Past the tombstone window the backstop prunes what it can, but an id whose
  // older request is still in flight must keep its retirement — otherwise that
  // stale response would win once it finally lands.
  it('never evicts a retirement that still guards a request in flight', async () => {
    const resolvers = new Map<string, ((value: string[]) => void)[]>();
    const fetcher = ({ id }: { id: string }) =>
      new Promise<string[]>((resolve) => {
        const pending = resolvers.get(id) ?? [];
        pending.push(resolve);
        resolvers.set(id, pending);
      });
    const { slice, store } = setup({ fetcher });

    const ids = Array.from({ length: DEFAULT_REMOVAL_TOMBSTONE_LIMIT + 1 }, (_, i) => `k${i}`);
    const stale = ids.map((id) => slice.fetch({ id }));
    const fresh = ids.map((id) => slice.fetch({ id }, { fresh: true }));

    // Every id still has its older request pending, so none may go.
    expect(slice.debugRetiredRequests()).toBe(DEFAULT_REMOVAL_TOMBSTONE_LIMIT + 1);

    const [oldFirst, freshFirst] = resolvers.get('k0')!;
    oldFirst(['stale']);
    await expect(stale[0]).resolves.toMatchObject({ applied: false, data: ['stale'] });
    expect(store.getState().lists.k0).toBeUndefined();

    freshFirst(['fresh']);
    await expect(fresh[0]).resolves.toMatchObject({ applied: true, data: ['fresh'] });
    expect(store.getState().lists.k0).toEqual(['fresh']);
    // `k0` has nothing older in flight any more, so its retirement is released.
    expect(slice.debugRetiredRequests()).toBe(DEFAULT_REMOVAL_TOMBSTONE_LIMIT);
  });
});
