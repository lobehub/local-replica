export type ReplicaPagingMode = 'cursor' | 'offset';
export type ReplicaPagingDirection = 'backward' | 'forward';

export interface ReplicaPagingConfig<TItem, TCursor = any> {
  /**
   * Cursor mode: cursor to the page past `item`, the last cursor-eligible row
   * on the far side, for a server that pages by row but reports no
   * `nextCursor` (a plain list). Only safe when the row carries a lossless
   * position; omit it when the server owns the cursor, and paging then waits
   * for one.
   */
  deriveCursor?: (item: TItem) => TCursor;
  direction: ReplicaPagingDirection;
  /**
   * Per-entry direction, for a resource whose entries read differently (a
   * transcript read from its first round). Defaults to `direction`. Persisting
   * an entry always uses `direction`, so keep such entries in memory.
   */
  directionOf?: (key: string) => ReplicaPagingDirection;
  getId: (item: TItem) => string;
  /**
   * Rows that may anchor a join or derive a cursor. Synthetic rows the query
   * injects (group / summary nodes) have no position of their own on the
   * server, so they are skipped. Defaults to every row.
   */
  isCursorable?: (item: TItem) => boolean;
  mode: ReplicaPagingMode;
  /** Which part survives a reload. Defaults to the head page only. */
  persist?: {
    /** Hard cap on persisted items (taken from the head side). */
    maxItems?: number;
    /** Number of pages from the head side. Default 1. */
    pages?: number;
  };
  /**
   * Optional total order re-applied after every merge (e.g. messages by
   * createdAt). The sort is stable: rows the comparator ties keep the order
   * the server sent them in, so compare positions only — an id tie-break
   * would reorder rows created within the same tick.
   */
  sort?: (a: TItem, b: TItem) => number;
}

export interface ReplicaPageResult<TItem, TCursor> {
  items: TItem[];
  /**
   * Cursor mode: next page cursor; `null` = exhausted, `undefined` = unknown.
   * Offset mode: the server's own verdict — `null` = exhausted, any other
   * value = more pages (the engine still advances by page index); `undefined`
   * falls back to `total` / a full page. A server that filters rows after
   * paging returns short pages that are not the end, so it must report this.
   */
  nextCursor?: TCursor | null;
  total?: number;
}

export interface ReplicaPageInfo<TCursor> {
  /** Items this page contributed after de-duplication. */
  count: number;
  /** Cursor of the page after this one; `null` = exhausted, `undefined` = unknown. */
  next?: TCursor | null;
}

/**
 * The paged view a resource keeps in the store. Domain views extend it, so
 * selectors read `items` / `hasMore` / `isLoadingMore` as before.
 */
export interface ReplicaPagedData<TItem, TCursor = number> {
  /**
   * Boundary row of the head page once more pages are loaded (forward: its
   * last row, backward: its first row). A refreshed head page that no longer
   * contains it has slid past the loaded pages — merging would hide a gap.
   */
  anchorId?: string;
  /** Index of the last merged page (0 = head only). */
  currentPage: number;
  hasMore: boolean;
  /**
   * Synthetic (non-cursorable) rows of the head page. A sort can place them
   * among older pages, so a head refresh drops them by id rather than by
   * position — the fresh head brings its own.
   */
  headSyntheticIds?: string[];
  isLoadingMore?: boolean;
  items: TItem[];
  loadMoreError?: unknown;
  /** Cursor for the next page (offset: page index). `null` = exhausted. */
  nextCursor?: TCursor | null;
  /** Per-page bookkeeping, head first. Missing on legacy data = one page. */
  pages?: ReplicaPageInfo<TCursor>[];
  pageSize: number;
  total?: number;
}

export interface ReplicaPagingContext<TItem> {
  /**
   * Client-only rows (optimistic inserts whose server row may not exist yet).
   * They survive head refreshes and are never persisted.
   */
  isClientOnly?: (item: TItem) => boolean;
}
