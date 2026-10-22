import { describe, expect, it } from 'vitest';

import {
  createReplicaState,
  type ReplicaAction,
  replicaReducer,
  type ReplicaViewWrite,
} from './reducer';
import type { ReplicaState } from './types';

type List = string[];

/** Applies view writes to a plain record, like a store lens would. */
const createHarness = () => {
  let state: ReplicaState<List> = createReplicaState();
  let view: Record<string, List> = {};
  const effects: unknown[] = [];

  const run = (action: ReplicaAction<List>) => {
    const transition = replicaReducer(state, action, (key) => view[key], 1);
    state = transition.state;
    for (const write of transition.writes as ReplicaViewWrite<List>[]) {
      if ('type' in write) view = {};
      else if (write.data === undefined) delete view[write.key];
      else view[write.key] = write.data;
    }
    effects.push(...transition.effects);
    return transition;
  };

  return {
    effects,
    run,
    get state() {
      return state;
    },
    get view() {
      return view;
    },
  };
};

const S = 'user-1:personal';

describe('replicaReducer edge cases', () => {
  it('keeps the stored value when a replayed seed write returns nothing', () => {
    const h = createHarness();
    // A seed that only fills an empty slot: replayed over a stored value it
    // has nothing to add, so it yields `undefined`.
    h.run({
      apply: (list) => (list ? undefined : ['seed']),
      key: 'k',
      persist: false,
      scope: S,
      source: 'seed',
      type: 'update',
    });
    expect(h.view.k).toEqual(['seed']);

    h.run({ data: ['stored'], key: 'k', scope: S, type: 'hydrate' });

    expect(h.view.k).toEqual(['stored']);
    expect(h.state.entries.k.source).toBe('storage');
  });

  it('records a replace that resolves to no value without writing or persisting', () => {
    const h = createHarness();
    const transition = h.run({ data: () => undefined, key: 'k', scope: S, type: 'replace' });

    expect(transition.writes).toEqual([]);
    expect(transition.effects).toEqual([]);
    expect(h.view.k).toBeUndefined();
    expect(h.state.entries.k).toMatchObject({ pending: [], source: 'server' });
  });

  it('confirms a base-only change under an overlay without repainting the view', () => {
    const h = createHarness();
    h.run({ data: () => ['a'], key: 'k', scope: S, type: 'replace' });
    h.run({ apply: (list) => [...list, 'opt'], id: 1, key: 'k', scope: S, type: 'optimistic' });
    const shown = h.view.k;

    // The write leaves a list that already shows `opt` alone, so only the
    // confirmed base moves.
    const transition = h.run({
      apply: (list) => (list?.includes('opt') ? list : [...(list ?? []), 'opt']),
      key: 'k',
      persist: true,
      scope: S,
      type: 'update',
    });

    expect(transition.writes).toEqual([]);
    expect(h.view.k).toBe(shown);
    expect(h.state.entries.k.base).toEqual(['a', 'opt']);
  });

  it('keeps a value deleted under an overlay gone when the overlay rolls back', () => {
    const h = createHarness();
    h.run({ data: () => ['a'], key: 'k', scope: S, type: 'replace' });
    h.run({ apply: (list) => [...list, 'opt'], id: 1, key: 'k', scope: S, type: 'optimistic' });
    h.run({ apply: () => undefined, key: 'k', persist: false, scope: S, type: 'update' });
    h.run({ id: 1, key: 'k', scope: S, type: 'rollback' });

    expect(h.view.k).toBeUndefined();
    expect(h.state.entries.k.pending).toEqual([]);
  });
});
