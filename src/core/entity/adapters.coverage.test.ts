import { describe, expect, it, vi } from 'vitest';

import { singleEntity } from './adapters';

interface Row {
  id: string;
  name: string;
}

describe('singleEntity', () => {
  it('keeps the value reference when the mapper returns the same entity', () => {
    const set = vi.fn();
    const adapter = singleEntity<{ project: Row }, Row>((row) => row.id, {
      get: (data) => data.project,
      set,
    });
    const value = { project: { id: 'p1', name: 'P' } };
    expect(adapter.map(value, 'p1', (row) => row)).toBe(value);
    expect(set).not.toHaveBeenCalled();
  });
});
