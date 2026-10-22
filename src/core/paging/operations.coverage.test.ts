import { describe, expect, it } from 'vitest';

import {
  applyHeadPage,
  applyNextPage,
  collapseToHead,
  getNextPageCursor,
  insertHeadItems,
  mapPagedItem,
  toPersistedPage,
} from './operations';
import type { ReplicaPagedData, ReplicaPagingConfig } from './types';

interface Row {
  id: string;
  synthetic?: boolean;
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (data: { items: Row[] }) => data.items.map((item) => item.id);

const offset: ReplicaPagingConfig<Row> = {
  direction: 'forward',
  getId: (row) => row.id,
  mode: 'offset',
};
const offsetBackward: ReplicaPagingConfig<Row> = { ...offset, direction: 'backward' };
const cursor: ReplicaPagingConfig<Row, string> = {
  direction: 'forward',
  getId: (row) => row.id,
  mode: 'cursor',
};
const cursorable: ReplicaPagingConfig<Row, string> = {
  ...cursor,
  isCursorable: (row) => !row.synthetic,
};

const view = (
  items: Row[],
  extra: Partial<ReplicaPagedData<Row, any>> = {},
): ReplicaPagedData<Row, any> => ({
  currentPage: 0,
  hasMore: true,
  items,
  pageSize: items.length,
  ...extra,
});

describe('getNextPageCursor edge cases', () => {
  it('cannot page an entry that has no view yet', () => {
    expect(getNextPageCursor(undefined, offset)).toBeUndefined();
  });

  it('treats an offset view without `currentPage` (legacy shape) as the head page', () => {
    const legacy = { hasMore: true, items: rows('a') } as unknown as ReplicaPagedData<Row>;
    expect(getNextPageCursor(legacy, offset)).toBe(1);
  });

  it('waits for a server cursor when no row can derive one', () => {
    const config = { ...cursorable, deriveCursor: (row: Row) => `after:${row.id}` };
    const onlySynthetic = view([{ id: 'group', synthetic: true }]);

    expect(getNextPageCursor(onlySynthetic, config)).toBeUndefined();
    expect(getNextPageCursor(view(rows('a', 'b')), config)).toBe('after:b');
  });
});

describe('applyHeadPage edge cases', () => {
  it('decides offset `hasMore` from a full page when the server reports no total', () => {
    const full = applyHeadPage(undefined, { items: rows('a', 'b') }, { pageSize: 2 }, offset);
    const short = applyHeadPage(undefined, { items: rows('a') }, { pageSize: 2 }, offset);

    expect(full).toMatchObject({ hasMore: true, nextCursor: 1 });
    expect(short).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('forgets the old total on a query reset when the new head reports none', () => {
    const current = view(rows('a', 'b'), { total: 10 });
    const next = applyHeadPage(
      current,
      { items: rows('x', 'y') },
      { pageSize: 2, reset: true },
      offset,
    );

    expect(next.total).toBeUndefined();
    expect(ids(next)).toEqual(['x', 'y']);
  });

  it('keeps the loaded offset depth when neither side reports a total', () => {
    const current = view(rows('a', 'b', 'c', 'd'), { currentPage: 1, pageSize: 2 });
    const next = applyHeadPage(current, { items: rows('n', 'a') }, { pageSize: 2 }, offset);

    // No `pages` bookkeeping (legacy shape): the rest is still kept up to the
    // loaded depth, and only the head page is recorded.
    expect(ids(next)).toEqual(['n', 'a', 'b', 'c']);
    expect(next.pages).toEqual([{ count: 2, next: undefined }]);
  });

  it('keeps the newest older rows on a backward offset view', () => {
    const current = view(rows('c', 'd', 'a', 'b'), { currentPage: 1, pageSize: 2, total: 4 });
    const next = applyHeadPage(
      current,
      { items: rows('a', 'b'), total: 4 },
      { pageSize: 2 },
      offsetBackward,
    );

    expect(ids(next)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('collapses an extended cursor view that never pinned a join anchor', () => {
    const current = view(rows('a', 'b', 'c'), { currentPage: 1, nextCursor: 'c3' });
    const next = applyHeadPage(
      current,
      { items: rows('a', 'b'), nextCursor: 'c2' },
      { pageSize: 2 },
      cursor,
    );

    expect(next.currentPage).toBe(0);
    expect(ids(next)).toEqual(['a', 'b']);
  });

  it('keeps the previous anchor when the fresh head has no cursorable row', () => {
    const anchor = { id: 'g', synthetic: true };
    const current = view([anchor, ...rows('c')], {
      anchorId: 'g',
      currentPage: 1,
      nextCursor: 'c-next',
      pages: [{ count: 1 }, { count: 1 }],
    });
    const next = applyHeadPage(current, { items: [anchor] }, { pageSize: 1 }, cursorable);

    expect(next.anchorId).toBe('g');
    expect(ids(next)).toEqual(['g', 'c']);
  });
});

describe('applyNextPage edge cases', () => {
  it('pins no anchor when the head page has no cursorable row', () => {
    const head = view([{ id: 'group', synthetic: true }], { nextCursor: 'n1' });
    const next = applyNextPage(head, { items: rows('a'), nextCursor: 'n2' }, cursorable);

    expect(next.anchorId).toBeUndefined();
    expect(next.currentPage).toBe(1);
  });

  it('records the head page from the loaded rows when the view has no page bookkeeping', () => {
    const head = view(rows('a', 'b'), { nextCursor: 'n1' });
    const next = applyNextPage(head, { items: rows('c'), nextCursor: null }, cursor);

    expect(next.pages).toEqual([{ count: 2 }, { count: 1, next: null }]);
    expect(next.hasMore).toBe(false);
  });
});

describe('insertHeadItems edge cases', () => {
  it('returns the same view when every inserted row is already loaded', () => {
    const current = view(rows('a', 'b'));
    expect(insertHeadItems(current, rows('a'), offset)).toBe(current);
  });

  it('counts inserted rows into the head page of a view without page bookkeeping', () => {
    const next = insertHeadItems(view(rows('a', 'b')), rows('n'), offset);

    expect(ids(next)).toEqual(['n', 'a', 'b']);
    expect(next.pages).toEqual([{ count: 3 }]);
    expect(next.total).toBeUndefined();
  });
});

describe('mapPagedItem edge cases', () => {
  it('returns the same view when the row is unchanged', () => {
    const current = view(rows('a', 'b'));
    expect(mapPagedItem(current, 'a', (row) => row, offset)).toBe(current);
  });

  it('keeps `hasMore` as is when a removal happens without a known total', () => {
    const current = view(rows('a', 'b'), { hasMore: true });
    const next = mapPagedItem(current, 'a', () => undefined, offset);

    expect(ids(next)).toEqual(['b']);
    expect(next.total).toBeUndefined();
    expect(next.hasMore).toBe(true);
  });
});

describe('collapseToHead edge cases', () => {
  it('returns a head-only view unchanged', () => {
    const current = view(rows('a'));
    expect(collapseToHead(current, offset)).toBe(current);
  });

  it('collapses an offset view to `pageSize` rows when it has no page bookkeeping', () => {
    const current = view(rows('a', 'b', 'c', 'd'), { currentPage: 1, pageSize: 2 });
    const next = collapseToHead(current, offset);

    expect(ids(next)).toEqual(['a', 'b']);
    expect(next).toMatchObject({ currentPage: 0, nextCursor: 1 });
  });

  it('forgets the cursor of a cursor view whose head page recorded none', () => {
    const current = view(rows('a', 'b', 'c'), {
      currentPage: 1,
      nextCursor: 'c3',
      pages: [{ count: 2 }, { count: 1, next: 'c3' }],
    });
    const next = collapseToHead(current, cursor);

    expect(ids(next)).toEqual(['a', 'b']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('collapses to no rows when the head page contributed none', () => {
    const current = view(rows('a', 'b'), {
      currentPage: 1,
      pages: [
        { count: 0, next: 'c1' },
        { count: 2, next: 'c2' },
      ],
    });
    const next = collapseToHead(current, cursor);

    expect(next.items).toEqual([]);
    expect(next.pages).toEqual([{ count: 0, next: 'c1' }]);
  });
});

describe('toPersistedPage edge cases', () => {
  it('persists a view without page bookkeeping as one head page', () => {
    const persisted = toPersistedPage(view(rows('a', 'b'), { nextCursor: 'c2' }), cursor);

    expect(ids(persisted)).toEqual(['a', 'b']);
    expect(persisted.pages).toEqual([{ count: 2, next: 'c2' }]);
    expect(persisted.nextCursor).toBe('c2');
  });

  it('keeps at least one offset page when `maxItems` is below the page size', () => {
    const config: ReplicaPagingConfig<Row> = { ...offset, persist: { maxItems: 1, pages: 3 } };
    const persisted = toPersistedPage(
      view(rows('a', 'b', 'c', 'd'), { currentPage: 1, pageSize: 2, total: 4 }),
      config,
    );

    expect(ids(persisted)).toEqual(['a']);
    expect(persisted.currentPage).toBe(0);
  });

  it('stops at the last whole cursor page that fits `maxItems` and forgets the cursor', () => {
    const config: ReplicaPagingConfig<Row, string> = {
      ...cursor,
      persist: { maxItems: 3, pages: 3 },
    };
    const persisted = toPersistedPage(
      view(rows('a', 'b', 'c', 'd'), {
        anchorId: 'b',
        currentPage: 1,
        nextCursor: 'c4',
        pages: [
          { count: 2, next: 'c2' },
          { count: 2, next: 'c4' },
        ],
      }),
      config,
    );

    expect(ids(persisted)).toEqual(['a', 'b']);
    expect(persisted.currentPage).toBe(0);
    expect(persisted.nextCursor).toBeUndefined();
  });
});
