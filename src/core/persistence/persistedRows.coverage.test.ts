import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaRow, ReplicaStorage } from '../../storage/types';
import { createReplicaEngine } from '../engine/createReplicaEngine';
import type { ReplicaStorePort } from '../engine/types';
import { defineReplica } from '../resource/defineReplica';
import type { ReplicaScope } from '../resource/types';
import { createReplicaState } from '../state/reducer';
import type { ReplicaState } from '../state/types';
import { REPLICA_INDEX_KEY } from './persistedRows';

type List = string[];

const scopeState = { current: 'u1', trusted: true };
const scope: ReplicaScope = {
  canPersist: () => scopeState.trusted,
  get: () => scopeState.current,
  use: () => scopeState.current,
};

afterEach(() => {
  scopeState.current = 'u1';
  scopeState.trusted = true;
  vi.restoreAllMocks();
});

/** A gate a storage call waits on until `open()`. */
const createGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { open, promise };
};

/** In-memory storage (index included) with hooks to stall or fail calls. */
const createStorage = () => {
  const rows = new Map<string, ReplicaRow<List>>();
  const id = (scopeId: string, queryKey: string) => `${scopeId}|${queryKey}`;
  const control = {
    /** Strict index reads left to fail. */
    failIndexReads: 0,
    /** When set, index reads wait for it. */
    indexReadGate: undefined as Promise<void> | undefined,
    /** When set, index writes wait for it; `indexWriteStarted` flips when one does. */
    indexWriteGate: undefined as Promise<void> | undefined,
    indexWriteStarted: false,
    /** When set, row deletes wait for it. */
    removeGate: undefined as Promise<void> | undefined,
  };
  const storage: ReplicaStorage<List> = {
    get: async ({ queryKey, scope: s }) => rows.get(id(s, queryKey)),
    getStrict: async ({ queryKey, scope: s }) => {
      if (queryKey === REPLICA_INDEX_KEY) {
        if (control.indexReadGate) await control.indexReadGate;
        if (control.failIndexReads > 0) {
          control.failIndexReads -= 1;
          throw new Error('index unreadable');
        }
      }
      return rows.get(id(s, queryKey));
    },
    remove: async ({ queryKey, scope: s }) => {
      if (queryKey !== REPLICA_INDEX_KEY && control.removeGate) await control.removeGate;
      rows.delete(id(s, queryKey));
    },
    set: async ({ queryKey, scope: s }, row) => {
      if (queryKey === REPLICA_INDEX_KEY && control.indexWriteGate) {
        control.indexWriteStarted = true;
        await control.indexWriteGate;
      }
      rows.set(id(s, queryKey), row);
    },
  };
  return {
    control,
    index: (s = 'u1') => rows.get(id(s, REPLICA_INDEX_KEY))?.data,
    row: (queryKey: string, s = 'u1') => rows.get(id(s, queryKey))?.data,
    seed: (queryKey: string, data: List, s = 'u1') =>
      rows.set(id(s, queryKey), { data, updatedAt: 1 }),
    storage,
  };
};

const createHost = () => {
  const host = { slot: createReplicaState<List>() as ReplicaState<List>, views: {} as Record<string, List> };
  const port: ReplicaStorePort<List> = {
    commit: (writes, state) => {
      for (const write of writes) {
        if ('type' in write) host.views = {};
        else if (write.data === undefined) delete host.views[write.key];
        else host.views[write.key] = write.data;
      }
      host.slot = state;
    },
    getState: () => host.slot,
    read: (key) => host.views[key],
  };
  return { host, port };
};

const setup = ({ maxEntries, withStorage = true }: { maxEntries?: number; withStorage?: boolean } = {}) => {
  const store = createStorage();
  const resource = defineReplica<{ id: string }, List>({
    key: ({ id }) => id,
    name: 'rows',
    persist: maxEntries === undefined ? undefined : { maxEntries },
    scope,
    storage: withStorage ? store.storage : undefined,
    version: 1,
  });
  const { host, port } = createHost();
  const engine = createReplicaEngine(resource, { port });
  const write = (key: string, data: List = [key]) => engine.update(key, () => data);
  return { engine, host, store, write };
};

/** Let queued storage work (promise chains, zero-delay timers) run out. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('bounded rows: retain', () => {
  it('ignores a repeated release, so another reader keeps the row pinned', async () => {
    const { engine, host, store, write } = setup({ maxEntries: 1 });
    write('a');
    await settle();
    const first = engine.retain('a');
    const second = engine.retain('a');
    first();
    first();

    write('b');
    await settle();
    // Still pinned by `second`: over the cap, but not evicted.
    expect(store.row('a')).toEqual(['a']);
    expect(host.views.a).toEqual(['a']);

    second();
    write('c');
    await settle();
    expect(store.row('a')).toBeUndefined();
    expect(host.views.a).toBeUndefined();
    expect(store.row('c')).toEqual(['c']);
  });
});

describe('bounded rows: eviction', () => {
  it('evicts rows of views seeded outside the engine without touching memory', async () => {
    const { engine, host, store } = setup({ maxEntries: 1 });
    // Written by code outside the replica: no bookkeeping, no slot scope yet.
    host.views = { a: ['a'], b: ['b'] };
    engine.persist('a');
    await settle();
    engine.persist('b');
    await settle();

    expect(store.row('a')).toBeUndefined();
    expect(store.row('b')).toEqual(['b']);
    expect(store.index()).toEqual(['b']);
    // Memory the engine does not own stays as it was.
    expect(host.views).toEqual({ a: ['a'], b: ['b'] });
  });

  it('does not evict once the scope stopped being trusted', async () => {
    const { host, store, write } = setup({ maxEntries: 1 });
    write('a');
    await settle();
    write('b');
    // The eviction runs after the index write; by then identity is a guess.
    scopeState.trusted = false;
    await settle();
    expect(store.row('a')).toEqual(['a']);
    expect(host.views.a).toEqual(['a']);

    scopeState.trusted = true;
    write('c');
    await settle();
    expect(store.row('a')).toBeUndefined();
    expect(store.row('b')).toBeUndefined();
    expect(store.index()).toEqual(['c']);
  });

  it('skips a picked row that got pinned before the eviction ran', async () => {
    const { engine, host, store, write } = setup({ maxEntries: 1 });
    write('a');
    await settle();

    const gate = createGate();
    store.control.indexWriteGate = gate.promise;
    write('b');
    // `a` was picked while the index was rewritten; it goes on screen now.
    await vi.waitFor(() => expect(store.control.indexWriteStarted).toBe(true));
    engine.retain('a');
    store.control.indexWriteGate = undefined;
    gate.open();
    await settle();

    expect(store.row('a')).toEqual(['a']);
    expect(host.views.a).toEqual(['a']);
    expect(store.index()).toEqual(['a', 'b']);
  });

  it('settles overlapping evictions of one scope', async () => {
    const { host, store, write } = setup({ maxEntries: 1 });
    const gate = createGate();
    write('a');
    await settle();
    store.control.removeGate = gate.promise;
    write('b');
    await settle();
    // `a`'s delete is still pending when `c` pushes `b` out as well.
    write('c');
    await settle();
    expect(host.views).toEqual({ c: ['c'] });

    gate.open();
    await settle();
    expect(store.row('a')).toBeUndefined();
    expect(store.row('b')).toBeUndefined();
    expect(store.index()).toEqual(['c']);

    // The eviction bookkeeping is clear: the next overflow evicts normally.
    store.control.removeGate = undefined;
    write('d');
    await settle();
    expect(store.index()).toEqual(['d']);
    expect(store.row('c')).toBeUndefined();
  });

  it('retries the index append after an unreadable index', async () => {
    const { store, write } = setup({ maxEntries: 5 });
    store.control.failIndexReads = 1;
    write('a');
    await settle();
    // The index was never rewritten as just this key.
    expect(store.row('a')).toEqual(['a']);
    expect(store.index()).toBeUndefined();

    write('a', ['a', 'again']);
    await settle();
    expect(store.index()).toEqual(['a']);
  });
});

describe('patchStoredRows', () => {
  it('patches unloaded rows, skips loaded and unchanged ones, drops `null` rows', async () => {
    const { engine, store, write } = setup();
    write('loaded', ['x']);
    await settle();
    for (const [key, data] of [
      ['other', ['x', 'y']],
      ['same', ['y']],
      ['gone', ['x']],
    ] as const)
      store.seed(key, [...data]);
    store.seed(REPLICA_INDEX_KEY, ['loaded', 'other', 'same', 'gone']);

    await engine.patchStoredRows((data) => {
      if (data.length === 1 && data[0] === 'x') return null;
      return data.includes('x') ? data.filter((item) => item !== 'x') : data;
    });
    await settle();

    // Loaded entries are patched through memory, never here.
    expect(store.row('loaded')).toEqual(['x']);
    expect(store.row('other')).toEqual(['y']);
    expect(store.row('same')).toEqual(['y']);
    expect(store.row('gone')).toBeUndefined();
    expect(store.index()).toEqual(['loaded', 'other', 'same']);
  });

  it('treats every row as unloaded while memory belongs to no scope yet', async () => {
    const { engine, store } = setup();
    store.seed('a', ['x']);
    store.seed(REPLICA_INDEX_KEY, ['a']);
    await engine.patchStoredRows((data) => [...data, 'patched']);
    expect(store.row('a')).toEqual(['x', 'patched']);
  });

  it('is a no-op without storage or in an untrusted scope', async () => {
    const fn = vi.fn((data: List) => data);
    await setup({ withStorage: false }).engine.patchStoredRows(fn);

    const { engine, store } = setup();
    store.seed('a', ['x']);
    store.seed(REPLICA_INDEX_KEY, ['a']);
    scopeState.trusted = false;
    await engine.patchStoredRows(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(store.row('a')).toEqual(['x']);
  });

  it('reports an unreadable index and patches nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, store } = setup();
    store.seed('a', ['x']);
    store.control.failIndexReads = 1;
    const fn = vi.fn((data: List) => [...data, 'patched']);

    await engine.patchStoredRows(fn);
    expect(fn).not.toHaveBeenCalled();
    expect(store.row('a')).toEqual(['x']);
    expect(error).toHaveBeenCalledWith(
      '[replica:rows] failed to read the persisted index',
      expect.any(Error),
    );
  });

  it('leaves rows alone when identity changed while the index was read', async () => {
    const { engine, store } = setup();
    store.seed('a', ['x']);
    store.seed(REPLICA_INDEX_KEY, ['a']);
    const gate = createGate();
    store.control.indexReadGate = gate.promise;
    const fn = vi.fn((data: List) => [...data, 'patched']);

    const pending = engine.patchStoredRows(fn);
    scopeState.current = 'u2';
    gate.open();
    await pending;
    expect(fn).not.toHaveBeenCalled();
    expect(store.row('a')).toEqual(['x']);
  });
});
