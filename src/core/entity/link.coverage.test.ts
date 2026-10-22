import { describe, expect, it, vi } from 'vitest';

import { linkReplicaEntity, type ReplicaEntityTarget } from './link';

/** A target that records every call; optional members are opt-in. */
const createTarget = ({
  clear,
  removeEntity = true,
}: { clear?: () => Promise<boolean>; removeEntity?: boolean } = {}) => {
  const target: ReplicaEntityTarget = {
    beginEntityOptimistic: vi.fn(() => []),
    clear,
    patchStoredEntity: vi.fn(async () => undefined),
    removeEntity: removeEntity ? vi.fn() : undefined,
    revalidate: vi.fn(async () => 'revalidated'),
    updateEntity: vi.fn(),
  };
  return target;
};

describe('linkReplicaEntity', () => {
  it('falls back to `updateEntity` for targets without `removeEntity`', () => {
    const plain = createTarget({ removeEntity: false });
    const guarded = createTarget();
    linkReplicaEntity([plain, guarded]).remove('t1', { persist: false });

    expect(guarded.removeEntity).toHaveBeenCalledWith('t1', { persist: false });
    expect(plain.updateEntity).toHaveBeenCalledTimes(1);
    const [id, fn, options] = vi.mocked(plain.updateEntity).mock.calls[0];
    expect(id).toBe('t1');
    expect(fn({ id: 't1' })).toBeUndefined();
    expect(options).toEqual({ persist: false });
  });

  it('never routes an off-scope removal through a fallback `updateEntity`', () => {
    // `updateEntity` would patch the scope on screen, not the one left behind.
    const plain = createTarget({ removeEntity: false });
    linkReplicaEntity([plain]).remove('t1', { scope: 'other' });
    expect(plain.updateEntity).not.toHaveBeenCalled();
  });

  it('treats targets without `clear` as already purged', async () => {
    const failing = createTarget({ clear: async () => false });
    const link = linkReplicaEntity([createTarget(), createTarget({ clear: async () => true })]);
    await expect(link.clear()).resolves.toBe(true);
    await expect(linkReplicaEntity([createTarget(), failing]).clear()).resolves.toBe(false);
  });

  it('revalidates every linked target', async () => {
    const targets = [createTarget(), createTarget()];
    await expect(linkReplicaEntity(targets).revalidate()).resolves.toEqual([
      'revalidated',
      'revalidated',
    ]);
    for (const target of targets) expect(target.revalidate).toHaveBeenCalledWith();
  });
});
