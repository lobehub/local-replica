import { describe, expect, it } from 'vitest';

import { defineReplica } from '../resource/defineReplica';
import { staticReplicaScope } from '../resource/scope';
import { createReplicaState } from '../state/reducer';
import type { ReplicaState } from '../state/types';
import { createReplicaEngine } from './createReplicaEngine';
import type { ReplicaStorePort } from './types';

describe('scopeClear', () => {
  it('clears a memory-only resource: memory goes, and there are no rows to purge', async () => {
    let state: ReplicaState<number> = createReplicaState<number>();
    let view: Record<string, number> = {};
    const port: ReplicaStorePort<number> = {
      commit: (writes, next) => {
        for (const write of writes) {
          if ('type' in write) view = {};
          else if (write.data === undefined) delete view[write.key];
          else view = { ...view, [write.key]: write.data };
        }
        state = next;
      },
      getState: () => state,
      read: (key) => view[key],
    };
    const resource = defineReplica<string, number>({
      key: (id) => id,
      name: 'memory',
      scope: staticReplicaScope('s'),
      version: 1,
    });
    const engine = createReplicaEngine(resource, { port });
    engine.replace('a', 1);

    await expect(engine.clear()).resolves.toBe(true);
    expect(view).toEqual({});
    await expect(engine.clearScope('other')).resolves.toBe(true);
    expect(engine.clearGeneration('other')).toBe(1);
  });
});
