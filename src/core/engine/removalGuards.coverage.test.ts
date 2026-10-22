import { describe, expect, it } from 'vitest';

import { createEntityRemovalGuards, createRemovalGuards } from './removalGuards';
import { DEFAULT_REMOVAL_TOMBSTONE_LIMIT } from './tombstones';

describe('createRemovalGuards', () => {
  it('bounds removal generations, forgetting the least recently removed key', () => {
    const guards = createRemovalGuards();
    guards.markRemoved('s', 'first');
    guards.markRemoved('s', 'second');
    // Removing `first` again makes `second` the least recently removed.
    guards.markRemoved('s', 'first');
    for (let i = 0; i < DEFAULT_REMOVAL_TOMBSTONE_LIMIT - 1; i++) guards.markRemoved('s', `k${i}`);

    expect(guards.removalGeneration('s', 'second')).toBe(0);
    expect(guards.removalGeneration('s', 'first')).toBe(2);
    expect(guards.removalGeneration('s', `k${DEFAULT_REMOVAL_TOMBSTONE_LIMIT - 2}`)).toBe(1);
  });
});

describe('createEntityRemovalGuards', () => {
  it('keeps a released guard while any hydrate that started before it is pending', () => {
    const guards = createEntityRemovalGuards();
    const settleFirst = guards.startHydrate('s');
    const settleSecond = guards.startHydrate('s');
    guards.guardEntity('s', 'e1')();

    settleSecond();
    expect(guards.removedIds('s')).toEqual(['e1']);
    settleFirst();
    expect(guards.removedIds('s')).toEqual([]);
  });

  it('lifts only the listed guards', () => {
    const guards = createEntityRemovalGuards();
    guards.guardEntity('s', 'e1');
    guards.guardEntity('s', 'e2');

    guards.liftEntityGuards('s', ['e1']);
    expect(guards.removedIds('s')).toEqual(['e2']);
    guards.liftEntityGuards('s', ['e2']);
    expect(guards.removedIds('s')).toEqual([]);
  });

  it('ignores a lift for a scope without guards', () => {
    const guards = createEntityRemovalGuards();
    guards.guardEntity('s', 'e1');
    guards.liftEntityGuards('other', ['e1']);
    expect(guards.removedIds('other')).toEqual([]);
    expect(guards.removedIds('s')).toEqual(['e1']);
  });
});
