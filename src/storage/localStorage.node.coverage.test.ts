// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { LocalStorageReplicaStorage } from './localStorage';

describe('LocalStorageReplicaStorage outside a browser', () => {
  it('treats every operation as a no-op miss', async () => {
    const storage = new LocalStorageReplicaStorage<string[]>({ namespace: 'test' });
    const key = { queryKey: 'q', scope: 's' };

    expect(typeof window).toBe('undefined');
    await expect(storage.set(key, { data: ['a'], updatedAt: 1 })).resolves.toBeUndefined();
    expect(storage.getSync(key)).toBeUndefined();
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(storage.getStrict(key)).resolves.toBeUndefined();
    await expect(storage.remove(key)).resolves.toBeUndefined();
  });
});
