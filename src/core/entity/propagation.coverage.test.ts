import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaRow, ReplicaStorage } from '../../storage/types';
import { createReplicaEngine } from '../engine/createReplicaEngine';
import type { ReplicaStorePort } from '../engine/types';
import type { ReplicaPagedData } from '../paging/types';
import { REPLICA_INDEX_KEY } from '../persistence/persistedRows';
import { definePagedReplica, defineReplica } from '../resource/defineReplica';
import type { ReplicaScope } from '../resource/types';
import { createReplicaState } from '../state/reducer';
import type { ReplicaState } from '../state/types';
import { arrayEntity, singleEntity } from './adapters';

interface Row {
  id: string;
  name: string;
}

const scopeState = { current: 'u1', throwOnPersistCheck: false, trusted: true };
const scope: ReplicaScope = {
  canPersist: () => {
    if (scopeState.throwOnPersistCheck) {
      scopeState.throwOnPersistCheck = false;
      throw new Error('identity store not ready');
    }
    return scopeState.trusted;
  },
  get: () => scopeState.current,
  use: () => scopeState.current,
};

afterEach(() => {
  scopeState.current = 'u1';
  scopeState.throwOnPersistCheck = false;
  scopeState.trusted = true;
});

const createGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { open, promise };
};

const createStorage = () => {
  const rows = new Map<string, ReplicaRow<any>>();
  const id = (s: string, queryKey: string) => `${s}|${queryKey}`;
  const control = { indexReadGate: undefined as Promise<void> | undefined };
  const read: ReplicaStorage<any>['get'] = async ({ queryKey, scope: s }) => {
    if (queryKey === REPLICA_INDEX_KEY && control.indexReadGate) await control.indexReadGate;
    return rows.get(id(s, queryKey));
  };
  const storage: ReplicaStorage<any> = {
    get: read,
    getStrict: read,
    remove: async ({ queryKey, scope: s }) => void rows.delete(id(s, queryKey)),
    set: async ({ queryKey, scope: s }, row) => void rows.set(id(s, queryKey), row),
  };
  return {
    control,
    row: (queryKey: string, s = 'u1') => rows.get(id(s, queryKey))?.data,
    seed: (queryKey: string, data: unknown, s = 'u1') => {
      rows.set(id(s, queryKey), { data, updatedAt: 1 });
      if (queryKey === REPLICA_INDEX_KEY) return;
      const index = (rows.get(id(s, REPLICA_INDEX_KEY))?.data as string[] | undefined) ?? [];
      rows.set(id(s, REPLICA_INDEX_KEY), { data: [...index, queryKey], updatedAt: 1 });
    },
    storage,
  };
};

/**
 * A plain-object host. `alias` maps entry keys onto one shared store location
 * (two keys answered by the same field); `keys` overrides the enumeration.
 */
const createHost = <T>({
  alias = {},
  keys,
}: { alias?: Record<string, string>; keys?: () => string[] | undefined } = {}) => {
  const host = { slot: createReplicaState<T>() as ReplicaState<T>, views: {} as Record<string, T> };
  const at = (key: string) => alias[key] ?? key;
  const port: ReplicaStorePort<T> = {
    commit: (writes, state) => {
      for (const write of writes) {
        if ('type' in write) host.views = {};
        else if (write.data === undefined) delete host.views[at(write.key)];
        else host.views[at(write.key)] = write.data;
      }
      host.slot = state;
    },
    getState: () => host.slot,
    keys: keys && (() => keys() ?? []),
    read: (key) => host.views[at(key)],
  };
  return { host, port };
};

/** Let queued storage work run out. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const setupList = ({
  entity = true,
  host = createHost<Row[]>(),
}: { entity?: boolean; host?: ReturnType<typeof createHost<Row[]>> } = {}) => {
  const store = createStorage();
  const resource = defineReplica<{ id: string }, Row[]>({
    key: ({ id }) => id,
    name: 'lists',
    scope,
    storage: store.storage,
    version: 1,
  });
  const engine = createReplicaEngine(resource, {
    entity: entity ? arrayEntity<Row>((row) => row.id) : undefined,
    port: host.port,
  });
  return { engine, host: host.host, store };
};

const setupDetail = (host = createHost<Row>()) => {
  const store = createStorage();
  const resource = defineReplica<{ id: string }, Row>({
    key: ({ id }) => id,
    name: 'details',
    scope,
    storage: store.storage,
    version: 1,
  });
  const engine = createReplicaEngine(resource, {
    entity: singleEntity<Row>((row) => row.id),
    port: host.port,
  });
  return { engine, host: host.host, store };
};

const p1 = (name: string): Row => ({ id: 'p1', name });
const dropDrafts = (row: Row) => (row.name === 'draft' ? undefined : { ...row, name: `${row.name}!` });

describe('entityKeys', () => {
  it('falls back to the bookkeeping entries when the port cannot enumerate keys', () => {
    const { engine, host } = setupList();
    engine.update('l1', () => [p1('a')]);
    expect(engine.entityKeys('p1')).toEqual(['l1']);
    engine.updateEntity<Row>('p1', (row) => ({ ...row, name: 'b' }), { persist: false });
    expect(host.views.l1).toEqual([p1('b')]);
  });

  it('skips enumerated keys that hold no value', () => {
    const { engine, host } = setupList({
      host: createHost<Row[]>({ keys: () => ['ghost', 'l1'] }),
    });
    engine.update('l1', () => [p1('a')]);
    expect(engine.entityKeys('p1')).toEqual(['l1']);
    engine.updateEntity<Row>('p1', (row) => ({ ...row, name: 'b' }), { persist: false });
    expect(host.views).toEqual({ l1: [p1('b')] });
  });

  it('finds nothing in a non-paged resource without an entity adapter', async () => {
    const { engine, host, store } = setupList({ entity: false });
    engine.update('l1', () => [p1('a')]);
    expect(engine.entityKeys('p1')).toEqual([]);
    engine.updateEntity<Row>('p1', (row) => ({ ...row, name: 'b' }));
    await settle();
    expect(host.views.l1).toEqual([p1('a')]);
    expect(store.row('l1')).toEqual([p1('a')]);
  });
});

describe('removal guards on hydrate', () => {
  it('cannot strip an entity from a value whose shape it does not know', async () => {
    const { engine, host, store } = setupList({ entity: false });
    store.seed('l1', [p1('a')]);
    // Untrusted: the storage patch fails, so the removal stays guarded.
    scopeState.trusted = false;
    engine.removeEntity('p1');
    await expect(engine.hydrate({ id: 'l1' })).resolves.toBe(true);
    expect(host.views.l1).toEqual([p1('a')]);
  });

  it('tolerates a persisted page without rows while a removal is guarded', async () => {
    const store = createStorage();
    const resource = definePagedReplica<{ id: string }, Row>({
      key: ({ id }) => id,
      name: 'pages',
      paging: { direction: 'forward', getId: (row) => row.id, mode: 'offset' },
      scope,
      storage: store.storage,
      version: 1,
    });
    const { host, port } = createHost<ReplicaPagedData<Row>>();
    const engine = createReplicaEngine(resource, { port });
    const legacy = { currentPage: 0, hasMore: false, pageSize: 20 };
    store.seed('l1', legacy);
    scopeState.trusted = false;
    engine.removeEntity('p1');

    await expect(engine.hydrate({ id: 'l1' })).resolves.toBe(true);
    expect(host.views.l1).toEqual(legacy);
  });
});

describe('persisted entity patches', () => {
  it('gives up on rows of a scope left while its index was read', async () => {
    const { engine, store } = setupList();
    store.seed('l1', [p1('a')]);
    const gate = createGate();
    store.control.indexReadGate = gate.promise;

    engine.updateEntity<Row>('p1', (row) => ({ ...row, name: 'b' }));
    scopeState.current = 'u2';
    gate.open();
    await settle();
    expect(store.row('l1')).toEqual([p1('a')]);
  });

  it('never recreates an indexed row that is already gone', async () => {
    const { engine, store } = setupList();
    store.seed('l1', [p1('a')]);
    // An index entry whose row was deleted behind the index.
    store.seed(REPLICA_INDEX_KEY, ['l1', 'ghost']);
    await engine.patchStoredEntity<Row>('p1', (row) => ({ ...row, name: 'b' }));
    expect(store.row('ghost')).toBeUndefined();
    expect(store.row('l1')).toEqual([p1('b')]);
  });
});

describe('updates under a pending overlay', () => {
  /**
   * `live` shows an overlay over a `draft` base; `orphan` shows one over a base
   * a later confirmed write dropped.
   */
  const seedOverlays = (engine: ReturnType<typeof setupDetail>['engine']) => {
    engine.update('live', () => p1('draft'));
    engine.update('orphan', () => p1('draft'));
    const tokens = ['live', 'orphan'].map((key) =>
      engine.beginOptimistic(key, (row) => ({ ...row, name: 'live' })),
    );
    engine.update('orphan', (row) => (row?.name === 'draft' ? undefined : row), {
      persist: false,
    });
    return tokens;
  };

  it('keeps a confirmed base the mapper would drop, and tolerates a missing one', () => {
    const { engine, host } = setupDetail();
    const [liveToken] = seedOverlays(engine);

    engine.updateEntity<Row>('p1', dropDrafts, { persist: false });
    expect(host.views.live).toEqual(p1('live!'));
    expect(host.views.orphan).toEqual(p1('live!'));

    // The base the mapper skipped is what a rollback falls back to.
    liveToken.rollback();
    expect(host.views.live).toEqual(p1('draft'));
  });

  it('applies the same rules when an off-scope patch is reconciled', async () => {
    const { engine, host, store } = setupDetail();
    const [liveToken] = seedOverlays(engine);
    const gate = createGate();
    store.control.indexReadGate = gate.promise;

    scopeState.current = 'u2';
    engine.updateEntity<Row>('p1', dropDrafts, { scope: 'u1' });
    // Back on `u1` before the patch of its rows landed.
    scopeState.current = 'u1';
    gate.open();
    await settle();

    expect(host.views.live).toEqual(p1('live!'));
    expect(host.views.orphan).toEqual(p1('live!'));
    liveToken.rollback();
    expect(host.views.live).toEqual(p1('draft'));
  });

  it('keeps the base when an entity overlay would drop it on rollback', () => {
    const { engine, host } = setupDetail();
    engine.update('d1', () => p1('draft'));
    const rename = engine.beginOptimistic('d1', (row) => ({ ...row, name: 'live' }));
    const [entityToken] = engine.beginEntityOptimistic<Row>('p1', dropDrafts);
    expect(host.views.d1).toEqual(p1('live!'));

    // Replaying the entity overlay onto the `draft` base would delete it.
    rename.rollback();
    expect(host.views.d1).toEqual(p1('draft'));
    entityToken.rollback();
    expect(host.views.d1).toEqual(p1('draft'));
  });
});

describe('keys sharing one store location', () => {
  const shared = () => createHost<Row>({ alias: { a: 'shared', b: 'shared' }, keys: () => ['a', 'b'] });

  it('skips a key whose value went with another key', () => {
    const { engine, host } = setupDetail(shared());
    engine.update('a', () => p1('x'));
    engine.update('b', () => p1('x'));
    engine.removeEntity('p1', { persist: false });
    expect(host.views).toEqual({});
  });

  it('reconciles an off-scope removal that settles after switching back', async () => {
    const { engine, host, store } = setupDetail(shared());
    engine.update('a', () => p1('x'));
    engine.update('b', () => p1('x'));
    await settle();
    const gate = createGate();
    store.control.indexReadGate = gate.promise;

    scopeState.current = 'u2';
    engine.removeEntity('p1', { scope: 'u1' });
    expect(host.views.shared).toEqual(p1('x'));
    scopeState.current = 'u1';
    gate.open();
    await settle();

    expect(host.views).toEqual({});
    expect(store.row('a')).toBeUndefined();
  });
});

describe('off-scope and in-memory-only changes', () => {
  it('ignores an off-scope update that is not persisted', async () => {
    const { engine, host, store } = setupList();
    engine.update('l1', () => [p1('a')]);
    await settle();
    scopeState.current = 'u2';
    engine.updateEntity<Row>('p1', (row) => ({ ...row, name: 'b' }), {
      persist: false,
      scope: 'u1',
    });
    await settle();
    expect(store.row('l1')).toEqual([p1('a')]);
    expect(host.views.l1).toEqual([p1('a')]);
  });

  it('releases the guard of a removal that patches no storage', async () => {
    // Off-scope: nothing on screen and no storage patch, so no guard is kept.
    const off = setupList();
    off.store.seed('l1', [p1('a')]);
    scopeState.current = 'u2';
    off.engine.removeEntity('p1', { persist: false, scope: 'u1' });
    scopeState.current = 'u1';
    await expect(off.engine.hydrate({ id: 'l1' })).resolves.toBe(true);
    expect(off.host.views.l1).toEqual([p1('a')]);

    // On-scope: memory drops the entity, the guard is released right away.
    const on = setupList();
    on.engine.update('l1', () => [p1('a')], { persist: false });
    on.store.seed('l2', [p1('a')]);
    on.engine.removeEntity('p1', { persist: false });
    expect(on.host.views.l1).toEqual([]);
    await expect(on.engine.hydrate({ id: 'l2' })).resolves.toBe(true);
    expect(on.host.views.l2).toEqual([p1('a')]);
  });

  it('keeps guarding a removal whose storage patch threw', async () => {
    const { engine, host, store } = setupList();
    store.seed('l1', [p1('a'), { id: 'p2', name: 'b' }]);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    scopeState.throwOnPersistCheck = true;

    engine.removeEntity('p1');
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    // The row still holds the entity; the kept guard strips it on hydrate.
    expect(store.row('l1')).toEqual([p1('a'), { id: 'p2', name: 'b' }]);
    await expect(engine.hydrate({ id: 'l1' })).resolves.toBe(true);
    expect(host.views.l1).toEqual([{ id: 'p2', name: 'b' }]);
  });
});
