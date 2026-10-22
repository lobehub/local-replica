import { describe, expect, it, vi } from 'vitest';

import type { ReplicaRow, ReplicaStorage } from '../../storage/types';
import type { ReplicaPagedData, ReplicaPageResult } from '../paging/types';
import { definePagedReplica, defineReplica } from '../resource/defineReplica';
import { replicaStorageKey, stableQueryKey } from '../resource/storageKey';
import type { ReplicaScope } from '../resource/types';
import { createReplicaState } from '../state/reducer';
import type { ReplicaState } from '../state/types';
import { createReplicaEngine } from './createReplicaEngine';
import type { ReplicaStorePort } from './types';

interface Item {
  id: string;
  pending?: boolean;
}
type Page = ReplicaPagedData<Item, number> & { filter?: unknown };
interface Params {
  filter?: string;
  id: string;
  pageSize?: number;
}

const scopeState = { current: 'u1' };
const scope: ReplicaScope = {
  canPersist: () => true,
  get: () => scopeState.current,
  use: () => scopeState.current,
};

const createHost = <T>() => {
  let state: ReplicaState<T> = createReplicaState<T>();
  let view: Record<string, T> = {};
  const port: ReplicaStorePort<T> = {
    commit: (writes, next) => {
      for (const write of writes) {
        if ('type' in write) view = {};
        else if (write.data === undefined) {
          const { [write.key]: _dropped, ...rest } = view;
          view = rest;
        } else view = { ...view, [write.key]: write.data };
      }
      state = next;
    },
    getState: () => state,
    read: (key) => view[key],
  };
  /** Put a value on screen without any replica bookkeeping (seeded by other code). */
  const seed = (key: string, data: T) => {
    view = { ...view, [key]: data };
  };
  return { port, read: (key: string) => view[key], seed };
};

const createStorage = () => {
  const rows = new Map<string, ReplicaRow<any>>();
  const id = ({ queryKey, scope }: { queryKey: string; scope: string }) => `${scope}|${queryKey}`;
  const storage: ReplicaStorage<any> = {
    get: async (key) => rows.get(id(key)),
    getStrict: async (key) => rows.get(id(key)),
    remove: async (key) => void rows.delete(id(key)),
    set: async (key, row) => void rows.set(id(key), row),
  };
  return { rows, storage };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const page = (ids: string[], extra: Partial<ReplicaPageResult<Item, number>> = {}) => ({
  items: ids.map((id) => ({ id })),
  ...extra,
});

const pagedResource = ({
  mode = 'offset',
  query,
  storage,
}: {
  mode?: 'cursor' | 'offset';
  query?: (params: Params) => unknown;
  storage?: ReplicaStorage<any>;
} = {}) =>
  definePagedReplica<Params, Item, number, Page>({
    key: (params) => params.id,
    name: 'paged',
    paging: { direction: 'forward', getId: (item) => item.id, mode },
    query,
    scope,
    storage,
    version: 1,
  });

describe('pagination: keepClientOnlyRows (overwrite hydrate)', () => {
  const setup = (isClientOnly?: (item: Item) => boolean) => {
    const { rows, storage } = createStorage();
    const host = createHost<Page>();
    const resource = pagedResource({ query: (params) => params.filter, storage });
    const engine = createReplicaEngine(resource, { isClientOnly, port: host.port });
    const storeRow = (filter: string, ids: string[]) =>
      rows.set(`u1|${replicaStorageKey('k', stableQueryKey(filter))}`, {
        data: { currentPage: 0, hasMore: false, items: ids.map((id) => ({ id })), pageSize: 2 },
        updatedAt: 1,
      });
    return { engine, host, storeRow };
  };

  it('keeps client-only rows of the view the stored page cannot contain', async () => {
    const { engine, host, storeRow } = setup((item) => !!item.pending);
    engine.replace({ filter: 'a', id: 'k' }, page(['old']));
    // An in-flight create, plus a client-only row the stored page already holds.
    engine.insertHead('k', [
      { id: 'tmp', pending: true },
      { id: 's1', pending: true },
    ]);
    storeRow('b', ['s1', 's2']);

    expect(await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true })).toBe(true);
    expect(host.read('k')!.items).toEqual([{ id: 'tmp', pending: true }, { id: 's1' }, { id: 's2' }]);
  });

  it('repaints the stored page as is when the view holds no client-only rows', async () => {
    const { engine, host, storeRow } = setup((item) => !!item.pending);
    engine.replace({ filter: 'a', id: 'k' }, page(['old']));
    storeRow('b', ['s1']);

    await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true });
    expect(host.read('k')!.items).toEqual([{ id: 's1' }]);
  });

  it('treats a view without rows as holding no client-only rows', async () => {
    const { engine, host, storeRow } = setup((item) => !!item.pending);
    engine.update('k', () => ({}) as Page, { persist: false });
    storeRow('b', ['s1']);

    await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true });
    expect(host.read('k')!.items).toEqual([{ id: 's1' }]);
  });

  it('hydrates an empty slot with the stored page when nothing is on screen', async () => {
    const { engine, host, storeRow } = setup((item) => !!item.pending);
    storeRow('b', ['s1']);

    await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true });
    expect(host.read('k')!.items).toEqual([{ id: 's1' }]);
  });

  it('drops the previous rows when the resource declares no client-only rows', async () => {
    const { engine, host, storeRow } = setup();
    engine.replace({ filter: 'a', id: 'k' }, page(['old']));
    engine.insertHead('k', [{ id: 'tmp', pending: true }]);
    storeRow('b', ['s1']);

    await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true });
    expect(host.read('k')!.items).toEqual([{ id: 's1' }]);
  });

  it('repaints a non-paged value from another query without touching it', async () => {
    const { rows, storage } = createStorage();
    const host = createHost<{ name: string }>();
    const resource = defineReplica<Params, { name: string }>({
      key: (params) => params.id,
      name: 'plain',
      query: (params) => params.filter,
      scope,
      storage,
      version: 1,
    });
    const engine = createReplicaEngine(resource, { port: host.port });
    engine.replace({ filter: 'a', id: 'k' }, { name: 'a' });
    rows.set(`u1|${replicaStorageKey('k', stableQueryKey('b'))}`, {
      data: { name: 'b' },
      updatedAt: 1,
    });

    await engine.hydrate({ filter: 'b', id: 'k' }, 'u1', { overwrite: true });
    expect(host.read('k')).toEqual({ name: 'b' });
  });
});

describe('pagination: viewFields of a view seeded without bookkeeping', () => {
  const setup = (viewFields?: (params: Params) => Partial<Page>) => {
    const host = createHost<Page>();
    const engine = createReplicaEngine(pagedResource(), { port: host.port, viewFields });
    // Two loaded pages and a known total, seeded by code outside the replica.
    host.seed('k', {
      currentPage: 1,
      filter: 'x',
      hasMore: true,
      items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      pageSize: 2,
      total: 10,
    });
    return { engine, host };
  };

  it('merges into the seeded pages when the view fields match the params', () => {
    const { engine, host } = setup((params) => ({ filter: params.filter }));
    engine.replace({ filter: 'x', id: 'k', pageSize: 2 }, page(['a', 'b']));
    expect(host.read('k')!.total).toBe(10);
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('resets the seeded pages when the view shows other fields', () => {
    const { engine, host } = setup((params) => ({ filter: params.filter }));
    engine.replace({ filter: 'y', id: 'k', pageSize: 2 }, page(['a', 'b']));
    expect(host.read('k')!.total).toBeUndefined();
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(host.read('k')!.filter).toBe('y');
  });

  it('treats falsy view fields as equivalent', () => {
    const { engine, host } = setup(() => ({ filter: undefined }));
    host.seed('k', { ...host.read('k')!, filter: false });
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b']));
    expect(host.read('k')!.total).toBe(10);
  });

  it('merges into a seeded view when the resource has no view fields', () => {
    const { engine, host } = setup();
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b']));
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('pagination: loadMore', () => {
  const setup = ({
    fetchPage,
    mode,
    query,
    storage,
  }: {
    fetchPage?: (params: Params, cursor?: number) => Promise<ReplicaPageResult<Item, number>>;
    mode?: 'cursor' | 'offset';
    query?: (params: Params) => unknown;
    storage?: ReplicaStorage<any>;
  } = {}) => {
    const host = createHost<Page>();
    const fetcher = fetchPage && vi.fn(fetchPage);
    const engine = createReplicaEngine(pagedResource({ mode, query, storage }), {
      fetcher,
      port: host.port,
    });
    return { engine, fetcher, host };
  };

  it('is a no-op for a resource that is not paged', async () => {
    const host = createHost<{ name: string }>();
    const fetcher = vi.fn(async () => ({ name: 'x' }));
    const resource = defineReplica<Params, { name: string }>({
      key: (params) => params.id,
      name: 'plain',
      scope,
      version: 1,
    });
    const engine = createReplicaEngine(resource, { fetcher, port: host.port });
    engine.replace({ id: 'k' }, { name: 'a' });

    await engine.loadMore('k');
    expect(fetcher).not.toHaveBeenCalled();
    expect(engine.insertHead('k', [{ id: 'x' }])).toBe(false);
    expect(engine.collapse('k')).toBe(false);
    expect(host.read('k')).toEqual({ name: 'a' });
  });

  it('is a no-op without a fetcher', async () => {
    const { engine, host } = setup();
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b'], { total: 4 }));
    await engine.loadMore('k');
    expect(host.read('k')!.currentPage).toBe(0);
  });

  it('does nothing for an entry that is not on screen', async () => {
    const { engine, fetcher } = setup({ fetchPage: async () => page(['c']) });
    await engine.loadMore('k');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs one request per entry at a time', async () => {
    const next = deferred<ReplicaPageResult<Item, number>>();
    const { engine, fetcher, host } = setup({ fetchPage: () => next.promise });
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b'], { total: 4 }));

    const first = engine.loadMore('k');
    expect(host.read('k')!.isLoadingMore).toBe(true);
    await engine.loadMore('k');
    expect(fetcher).toHaveBeenCalledTimes(1);

    next.resolve(page(['c', 'd'], { total: 4 }));
    await first;
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(host.read('k')!.isLoadingMore).toBe(false);
  });

  it('does not page from a hydrated cursor in cursor mode', async () => {
    const { rows, storage } = createStorage();
    rows.set('u1|k', {
      data: { currentPage: 0, hasMore: true, items: [{ id: 'a' }], nextCursor: 7, pageSize: 1 },
      updatedAt: 1,
    });
    const { engine, fetcher } = setup({ fetchPage: async () => page(['b']), mode: 'cursor', storage });
    await engine.hydrate({ id: 'k' });

    await engine.loadMore('k');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pages a view seeded outside useSync with the fallback params', async () => {
    const { engine, fetcher, host } = setup({ fetchPage: async () => page(['c']) });
    host.seed('k', { currentPage: 0, hasMore: true, items: [{ id: 'a' }], pageSize: 1 });

    await engine.loadMore('k');
    expect(fetcher).not.toHaveBeenCalled();

    await engine.loadMore('k', { id: 'k' });
    expect(fetcher).toHaveBeenCalledWith({ id: 'k' }, 1);
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('does not fetch past an exhausted list', async () => {
    const { engine, fetcher } = setup({ fetchPage: async () => page(['c']) });
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b'], { nextCursor: null }));

    await engine.loadMore('k');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces a failure on the view it was requested for', async () => {
    const error = new Error('offline');
    const { engine, host } = setup({ fetchPage: () => Promise.reject(error) });
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b'], { total: 4 }));

    await engine.loadMore('k');
    expect(host.read('k')!.isLoadingMore).toBe(false);
    expect(host.read('k')!.loadMoreError).toBe(error);
  });

  it('does not surface a failure on a view that moved to another query', async () => {
    const next = deferred<ReplicaPageResult<Item, number>>();
    const { engine, host } = setup({
      fetchPage: () => next.promise,
      query: (params) => params.filter,
    });
    engine.replace({ filter: 'a', id: 'k', pageSize: 2 }, page(['a', 'b'], { total: 4 }));

    const loading = engine.loadMore('k');
    engine.replace({ filter: 'b', id: 'k', pageSize: 2 }, page(['x', 'y'], { total: 4 }));
    next.reject(new Error('late'));
    await loading;

    expect(host.read('k')!.loadMoreError).toBeUndefined();
    expect(host.read('k')!.isLoadingMore).toBe(false);
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['x', 'y']);
  });
});

describe('pagination: collapse', () => {
  it('drops the loaded pages back to the head page', async () => {
    const host = createHost<Page>();
    const engine = createReplicaEngine(pagedResource(), {
      fetcher: async () => page(['c', 'd'], { total: 4 }),
      port: host.port,
    });
    engine.replace({ id: 'k', pageSize: 2 }, page(['a', 'b'], { total: 4 }));
    await engine.loadMore('k');
    expect(host.read('k')!.currentPage).toBe(1);

    expect(engine.collapse('k')).toBe(true);
    expect(host.read('k')!.currentPage).toBe(0);
    expect(host.read('k')!.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('leaves an entry that is not on screen alone', () => {
    const host = createHost<Page>();
    const engine = createReplicaEngine(pagedResource(), { port: host.port });
    engine.collapse('missing');
    expect(host.read('missing')).toBeUndefined();
  });
});
