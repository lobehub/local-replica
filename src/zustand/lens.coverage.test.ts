import { describe, expect, it } from 'vitest';

import type { ReplicaPagedData } from '../core/paging/types';
import { recordLens, splitPagedLens } from './lens';

interface RecordState {
  lists?: Record<string, string[]>;
}

interface PagedState {
  items?: Record<string, string[]>;
  meta?: Record<string, Omit<ReplicaPagedData<string, number>, 'items'>>;
  total?: number;
}

const paged = (items: string[], currentPage = 0): ReplicaPagedData<string, number> => ({
  currentPage,
  hasMore: true,
  items,
  pageSize: 2,
});

describe('recordLens', () => {
  it('reads a missing backing field as an empty record', () => {
    const lens = recordLens<RecordState, string[]>('lists');

    expect(lens.keys!({})).toEqual([]);
    expect(lens.get({}, 'a')).toBeUndefined();
  });
});

describe('splitPagedLens', () => {
  const lens = () =>
    splitPagedLens<PagedState, string, number>({ itemsField: 'items', metaField: 'meta' });

  it('reads missing backing fields as no entries', () => {
    expect(lens().get({}, 'a')).toBeUndefined();
    expect(lens().keys!({})).toEqual([]);
  });

  it('clears both fields, plus the derived ones when the lens has any', () => {
    expect(lens().clear({})).toEqual({ items: {}, meta: {} });

    const derived = splitPagedLens<PagedState, string, number>({
      clearDerived: () => ({ total: 0 }),
      itemsField: 'items',
      metaField: 'meta',
    });
    expect(derived.clear({})).toEqual({ items: {}, meta: {}, total: 0 });
  });

  it('returns one view object per rows + bookkeeping pair', () => {
    const view = lens();
    const items = ['a', 'b'];
    const first = paged(items, 0);
    const state1 = view.set({}, 'k', first) as PagedState;
    expect(view.get(state1, 'k')).toBe(first);

    // Same rows, new bookkeeping: a second view of the same rows is remembered too.
    const second = paged(items, 1);
    const state2 = view.set(state1, 'k', second) as PagedState;
    expect(view.get(state2, 'k')).toBe(second);
    expect(view.get(state1, 'k')).toBe(first);
  });

  it('assembles (and then reuses) a view from bookkeeping written outside the lens', () => {
    const view = lens();
    const meta = { currentPage: 1, hasMore: false, pageSize: 2 };
    const state: PagedState = { items: { k: ['a', 'b'] }, meta: { k: meta } };

    const read = view.get(state, 'k');

    expect(read).toEqual({ ...meta, items: ['a', 'b'] });
    expect(view.get(state, 'k')).toBe(read);
  });
});
