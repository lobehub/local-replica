import { act } from '@testing-library/react';
import useSWR, { mutate } from 'swr';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { defineReplica } from '../core/resource/defineReplica';
import { createReplicaState } from '../core/state/reducer';
import type { ReplicaState } from '../core/state/types';
import { createReplicaSlice } from './createReplicaSlice';
import { createSWRDriver } from './driver';
import { recordLens } from './lens';

interface Topic {
  id: string;
  title: string;
}

interface Store {
  topicsById: Record<string, Topic[]>;
  topicsReplica: ReplicaState<Topic[]>;
}

describe('createReplicaSlice inference', () => {
  it('takes the store type from get / set, with SWR passed as is', () => {
    const topics = defineReplica<{ agentId: string }, Topic[]>({
      key: ({ agentId }) => agentId,
      name: 'topics',
      version: 1,
    });
    const store = createStore<Store>()(() => ({
      topicsById: {},
      topicsReplica: createReplicaState(),
    }));

    // No explicit generics: `stateKey` and `view` are checked against the store from `get`.
    const slice = createReplicaSlice(topics, {
      driver: createSWRDriver({ mutate, useSWR }),
      get: store.getState,
      set: store.setState,
      stateKey: 'topicsReplica',
      view: recordLens('topicsById'),
    });

    expectTypeOf(slice.replace).parameter(1).toEqualTypeOf<Topic[]>();

    act(() => slice.replace({ agentId: 'a' }, [{ id: '1', title: 'Q3 roadmap' }]));
    expect(store.getState().topicsById.a).toEqual([{ id: '1', title: 'Q3 roadmap' }]);
  });
});
