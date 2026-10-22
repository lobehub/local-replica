import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaRow, ReplicaStorage } from '../../storage/types';
import { defineReplica } from '../resource/defineReplica';
import type { ReplicaScope } from '../resource/types';
import { createReplicaState } from '../state/reducer';
import type { ReplicaState } from '../state/types';
import { createReplicaEngine } from './createReplicaEngine';
import type { ReplicaEngineOptions, ReplicaStorePort } from './types';

interface Value {
  n: number;
  tag?: string;
}

const scopeState = { current: 'u1' };
const scope: ReplicaScope = {
  canPersist: () => true,
  get: () => scopeState.current,
  use: () => scopeState.current,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  return { port, read: (key: string) => view[key] };
};

const createStorage = () => {
  const rows = new Map<string, ReplicaRow<any>>();
  const failRemoves = new Set<string>();
  const writes: string[] = [];
  const id = ({ queryKey, scope }: { queryKey: string; scope: string }) => `${scope}|${queryKey}`;
  const storage: ReplicaStorage<any> = {
    get: async (key) => rows.get(id(key)),
    getStrict: async (key) => rows.get(id(key)),
    remove: async (key) => {
      if (failRemoves.has(key.queryKey)) throw new Error('delete failed');
      rows.delete(id(key));
    },
    set: async (key, row) => {
      writes.push(`${key.scope}|${key.queryKey}`);
      rows.set(id(key), row);
    },
  };
  return { failRemoves, rows, storage, writes };
};

const setup = ({
  persistKey,
  storage,
  ...options
}: Omit<ReplicaEngineOptions<{ id: string }, Value, Value>, 'port'> & {
  persistKey?: (key: string) => boolean;
  storage?: ReplicaStorage<any>;
} = {}) => {
  const host = createHost<Value>();
  const resource = defineReplica<{ id: string }, Value>({
    key: (params) => params.id,
    name: 'value',
    persistKey,
    scope,
    storage,
    version: 1,
  });
  const engine = createReplicaEngine(resource, { ...options, port: host.port });
  return { engine, host };
};

beforeEach(() => {
  scopeState.current = 'u1';
});

describe('createReplicaEngine', () => {
  it('lets a later write in one batch build on an earlier write to the same key', () => {
    const { engine, host } = setup();
    const seen: (Value | undefined)[] = [];
    engine.updateMany([
      { apply: () => ({ n: 1 }), key: 'k' },
      {
        apply: (data) => {
          seen.push(data);
          return { n: data!.n + 1 };
        },
        key: 'k',
      },
    ]);
    expect(seen).toEqual([{ n: 1 }]);
    expect(host.read('k')).toEqual({ n: 2 });
  });

  it('reads the confirmed value under an optimistic overlay', () => {
    const { engine, host } = setup();
    engine.replace({ id: 'k' }, { n: 1 });
    const token = engine.beginOptimistic('k', (data) => ({ ...data, n: 99 }));
    expect(host.read('k')).toEqual({ n: 99 });
    expect(engine.getConfirmed('k')).toEqual({ n: 1 });
    token.rollback();
    expect(host.read('k')).toEqual({ n: 1 });
  });

  it('does not hydrate a memory-only resource', async () => {
    const { engine } = setup();
    expect(await engine.hydrate({ id: 'k' })).toBe(false);
  });

  it('rejects a stored value that cannot serve the params', async () => {
    const { rows, storage } = createStorage();
    rows.set('u1|k', { data: { n: 1 }, updatedAt: 1 });
    const isHydratable = vi.fn((cached: Value) => cached.n > 1);
    const { engine, host } = setup({ isHydratable, storage });

    expect(await engine.hydrate({ id: 'k' })).toBe(false);
    expect(isHydratable).toHaveBeenCalledWith({ n: 1 }, { id: 'k' });
    expect(host.read('k')).toBeUndefined();
  });

  it('folds a response through `merge`', () => {
    const merge = vi.fn((incoming: Value, confirmed: Value | undefined) => ({
      n: incoming.n + (confirmed?.n ?? 0),
    }));
    const { engine, host } = setup({ merge });
    engine.replace({ id: 'k' }, { n: 1 });
    engine.replace({ id: 'k' }, { n: 2 });
    expect(host.read('k')).toEqual({ n: 3 });
    expect(merge).toHaveBeenLastCalledWith({ n: 2 }, { n: 1 }, { id: 'k' });
  });

  describe('off-scope removal (purge)', () => {
    it('only arms the guard when there is nothing persisted, once', () => {
      const { engine } = setup();
      expect(engine.remove('k', 'u0')).toBe(false);
      expect(engine.removalGeneration('u0', 'k')).toBe(1);
      // Already removed and purged: a repeat is a real no-op.
      expect(engine.remove('k', 'u0')).toBe(false);
      expect(engine.removalGeneration('u0', 'k')).toBe(1);
    });

    it('treats a key the resource never persists as already purged', () => {
      const { storage, writes } = createStorage();
      const { engine } = setup({ persistKey: () => false, storage });
      expect(engine.remove('k', 'u0')).toBe(false);
      expect(engine.remove('k', 'u0')).toBe(false);
      expect(writes).toEqual([]);
    });

    it('deletes the row of the scope left behind, then is a no-op', async () => {
      const { rows, storage } = createStorage();
      rows.set('u0|k', { data: { n: 1 }, updatedAt: 1 });
      const { engine } = setup({ storage });

      expect(engine.remove('k', 'u0')).toBe(true);
      await flush();
      expect(rows.has('u0|k')).toBe(false);
      expect(engine.remove('k', 'u0')).toBe(false);
    });

    it('keeps retrying while the row delete fails', async () => {
      const { failRemoves, rows, storage } = createStorage();
      rows.set('u0|k', { data: { n: 1 }, updatedAt: 1 });
      failRemoves.add('k');
      const { engine } = setup({ storage });

      expect(engine.remove('k', 'u0')).toBe(true);
      await flush();
      expect(rows.has('u0|k')).toBe(true);
      // Unpurged: the next removal tries the delete again.
      failRemoves.clear();
      expect(engine.remove('k', 'u0')).toBe(true);
      await flush();
      expect(rows.has('u0|k')).toBe(false);
    });
  });

  describe('persist', () => {
    it('writes the confirmed value after in-memory writes', async () => {
      const { storage, writes } = createStorage();
      const { engine } = setup({ storage });
      engine.update('k', () => ({ n: 1 }), { persist: false });
      await flush();
      expect(writes).toEqual([]);

      engine.persist('k');
      await flush();
      expect(writes).toContain('u1|k');
    });

    it('skips an entry with no value', async () => {
      const { storage, writes } = createStorage();
      const { engine } = setup({ storage });
      engine.persist('missing');
      await flush();
      expect(writes).toEqual([]);
    });

    it('never writes memory of another identity into the active scope', async () => {
      const { storage, writes } = createStorage();
      const { engine } = setup({ storage });
      engine.update('k', () => ({ n: 1 }), { persist: false });
      scopeState.current = 'u2';

      engine.persist('k');
      await flush();
      expect(writes).toEqual([]);
    });
  });

  describe('revalidate', () => {
    it('resolves without an adapter-provided revalidate', async () => {
      const { engine } = setup();
      await expect(engine.revalidate('k')).resolves.toBeUndefined();
    });

    it('forwards to the adapter', async () => {
      const revalidate = vi.fn(async () => 'done');
      const { engine } = setup({ revalidate });
      await expect(engine.revalidate('k')).resolves.toBe('done');
      expect(revalidate).toHaveBeenCalledWith('k');
    });

    it('runs after an optimistic mutation that asks for it, whether it succeeds or fails', async () => {
      const revalidate = vi.fn(async () => undefined);
      const { engine, host } = setup({ revalidate });
      engine.replace({ id: 'k' }, { n: 1 });

      await engine.optimistic('k', (data) => ({ ...data, n: 2 }), async () => 'ok', {
        revalidate: true,
      });
      expect(host.read('k')).toEqual({ n: 2 });
      expect(revalidate).toHaveBeenCalledTimes(1);

      await expect(
        engine.optimistic(
          'k',
          (data) => ({ ...data, n: 3 }),
          async () => {
            throw new Error('nope');
          },
          { revalidate: true },
        ),
      ).rejects.toThrow('nope');
      expect(host.read('k')).toEqual({ n: 2 });
      expect(revalidate).toHaveBeenCalledTimes(2);

      await engine.optimistic('k', (data) => ({ ...data, n: 4 }), async () => 'ok');
      expect(revalidate).toHaveBeenCalledTimes(2);
    });
  });
});
