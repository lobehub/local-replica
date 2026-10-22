import { describe, expect, it } from 'vitest';

import { isReplicaSyncKey, replicaKeys } from './queryKeys';
import { staticReplicaScope } from './scope';
import { isReplicaStorageKeyOf, replicaStorageKey, stableQueryKey } from './storageKey';

describe('isReplicaSyncKey', () => {
  const key = replicaKeys.sync('topics', 1, 'user-a', 'agent-1', { page: 1 });

  it('matches a resource sync key, optionally narrowed by scope and entry key', () => {
    expect(isReplicaSyncKey(key, 'topics')).toBe(true);
    expect(isReplicaSyncKey(key, 'topics', { key: 'agent-1', scope: 'user-a' })).toBe(true);
    expect(isReplicaSyncKey(key, 'topics', { scope: 'user-b' })).toBe(false);
    expect(isReplicaSyncKey(key, 'topics', { key: 'agent-2' })).toBe(false);
  });

  it('rejects other resources, hydrate keys and non-array keys', () => {
    expect(isReplicaSyncKey(key, 'messages')).toBe(false);
    expect(isReplicaSyncKey(replicaKeys.hydrate('topics', 1, 'user-a', 'agent-1'), 'topics')).toBe(
      false,
    );
    expect(isReplicaSyncKey('replica:sync', 'topics')).toBe(false);
  });
});

describe('staticReplicaScope', () => {
  it('is a fixed, always-trusted partition', () => {
    const scope = staticReplicaScope('team');
    expect(scope.get()).toBe('team');
    expect(scope.use()).toBe('team');
    expect(scope.canPersist()).toBe(true);
    expect(staticReplicaScope().get()).toBe('default');
  });
});

describe('storage key encoding', () => {
  it('treats the bare entry key as a row of that entry', () => {
    expect(isReplicaStorageKeyOf('topic-1', 'topic-1')).toBe(true);
    expect(isReplicaStorageKeyOf(replicaStorageKey('topic-1', '{"a":1}'), 'topic-1')).toBe(true);
    expect(isReplicaStorageKeyOf('topic-10', 'topic-1')).toBe(false);
  });

  it('encodes a value JSON cannot represent as an empty key', () => {
    expect(stableQueryKey(undefined)).toBe('');
    expect(replicaStorageKey('k', stableQueryKey(undefined))).toBe('k');
  });
});
