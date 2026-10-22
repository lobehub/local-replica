import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalStorageReplicaStorage } from './localStorage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LocalStorageReplicaStorage strict reads', () => {
  it('returns the row or a miss', async () => {
    const storage = new LocalStorageReplicaStorage<string[]>({ namespace: 'test' });
    const key = { queryKey: 'q', scope: 's' };

    await expect(storage.getStrict(key)).resolves.toBeUndefined();
    await storage.set(key, { data: ['a'], updatedAt: 1 });
    await expect(storage.getStrict(key)).resolves.toEqual({ data: ['a'], updatedAt: 1 });
  });
});
