import { describe, expect, it } from 'vitest';

import { createTombstones } from './tombstones';

describe('createTombstones', () => {
  it('drops a scope bucket that eviction emptied', () => {
    const tombstones = createTombstones(2);
    tombstones.add('s1', 'a');
    tombstones.add('s2', 'b');
    tombstones.add('s2', 'c');

    expect(tombstones.size()).toBe(2);
    expect(tombstones.has('s1', 'a')).toBe(false);
    // The emptied bucket is gone: re-adding starts it as the newest scope.
    tombstones.add('s1', 'd');
    expect(tombstones.has('s2', 'b')).toBe(false);
    expect(tombstones.has('s2', 'c')).toBe(true);
    expect(tombstones.has('s1', 'd')).toBe(true);
  });

  it('keeps a scope bucket that still holds keys after a clear', () => {
    const tombstones = createTombstones();
    tombstones.add('s', 'a');
    tombstones.add('s', 'b');

    tombstones.clear('s', 'a');
    expect(tombstones.has('s', 'b')).toBe(true);
    expect(tombstones.size()).toBe(1);
  });
});
