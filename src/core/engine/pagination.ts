import isEqual from 'fast-deep-equal';

import {
  applyHeadPage,
  applyNextPage,
  collapseToHead,
  getNextPageCursor,
  insertHeadItems,
  joinPages,
  pagingFor,
  toPersistedPage,
} from '../paging/operations';
import type { ReplicaPagedData, ReplicaPageResult, ReplicaPagingContext } from '../paging/types';
import { stableQueryKey } from '../resource/storageKey';
import type { ReplicaResource } from '../resource/types';
import type { ReplicaSource, ReplicaState } from '../state/types';
import type { ReplicaEngineOptions, ReplicaStorePort } from './types';

export interface ReplicaPaginationDeps<TParams, TData, TFetched> {
  fetcher?: (params: TParams, cursor?: any) => Promise<TFetched>;
  getSlot: () => ReplicaState<TData>;
  /** Keys with a `loadMore` request in flight (the only valid `isLoadingMore`). */
  loadingMore: Set<string>;
  options: Pick<ReplicaEngineOptions<TParams, TData, TFetched>, 'isClientOnly' | 'viewFields'>;
  port: ReplicaStorePort<TData>;
  resource: ReplicaResource<TParams, TData, TFetched>;
  update: (
    key: string,
    apply: (data: TData | undefined) => TData | undefined,
    options?: { persist?: boolean; seedTag?: string; source?: ReplicaSource },
  ) => boolean;
}

/**
 * The engine's paged-resource transitions: folding a head page into the loaded
 * pages, fetching the next page, head inserts and collapsing back to the head.
 * The pure page math lives in `paging/operations.ts`; this adds the entry,
 * scope and in-flight bookkeeping around it. Every method is a no-op (or a
 * pass-through) for a non-paged resource.
 */
export const createPagination = <TParams, TData, TFetched>({
  fetcher,
  getSlot,
  loadingMore,
  options,
  port,
  resource,
  update,
}: ReplicaPaginationDeps<TParams, TData, TFetched>) => {
  const paging = resource.paging;
  const at = (key: string) => pagingFor(paging!, key);
  const pagingCtx: ReplicaPagingContext<any> = { isClientOnly: options.isClientOnly };

  /** The persistable part of a paged value (the value itself when not paged). */
  const toPersisted = (data: TData): TData =>
    paging ? (toPersistedPage(data as any, paging, pagingCtx) as TData) : data;

  /**
   * An overwrite hydrate repaints the entry from another query's persisted page.
   * Client-only rows (an in-flight upload / create) have no server row yet, so
   * that page cannot contain them — keep the ones still in the view, so a
   * same-pool query change (a re-sort, a view-mode switch) never drops them.
   * A cross-pool navigate is not "client-only" for the new params and is dropped.
   */
  const keepClientOnlyRows = (incoming: TData, current: TData | undefined, key: string): TData => {
    if (!paging || !options.isClientOnly || !current) return incoming;
    const page = incoming as unknown as ReplicaPagedData<unknown, unknown>;
    const currentItems = (current as unknown as ReplicaPagedData<unknown, unknown>).items ?? [];
    const incomingIds = new Set(page.items.map((item) => paging.getId(item)));
    const survivors = currentItems.filter(
      (item) => options.isClientOnly!(item) && !incomingIds.has(paging.getId(item)),
    );
    if (survivors.length === 0) return incoming;
    const items = joinPages(survivors, page.items, at(key).direction);
    return { ...(incoming as object), items } as TData;
  };

  const viewMatchesFields = (current: TData | undefined, params: TParams) => {
    const fields = options.viewFields?.(params);
    if (!current || !fields) return true;
    // Falsy descriptors (undefined / false / null) are equivalent.
    const norm = (value: unknown) => stableQueryKey(value || null);
    return Object.entries(fields).every(
      ([field, value]) => norm(value) === norm((current as Record<string, unknown>)[field]),
    );
  };

  const mergeHead = (
    key: string,
    incoming: TFetched,
    confirmed: TData | undefined,
    params: TParams,
    reset: boolean,
  ) => {
    const page = incoming as unknown as ReplicaPageResult<unknown, unknown>;
    const pageSize = (params as { pageSize?: number }).pageSize ?? page.items.length;
    const merged = {
      ...applyHeadPage(confirmed as any, page, { pageSize, reset }, at(key), pagingCtx),
      ...options.viewFields?.(params),
      isLoadingMore: loadingMore.has(key),
    };
    // Keep domain-only fields of the current view (e.g. transient flags).
    const next = { ...(confirmed as object), ...merged } as TData;
    return confirmed !== undefined && isEqual(next, confirmed) ? undefined : next;
  };

  /**
   * Fetch and merge the next page with the params of the loaded head page
   * (`fallbackParams` covers views seeded outside `useSync`). In `cursor` mode
   * paging only starts from a server-confirmed head page: a hydrated cursor
   * may be stale. A result is dropped when the scope, the query or the loaded
   * depth changed while it was in flight.
   */
  const loadMore = async (key: string, fallbackParams?: TParams): Promise<void> => {
    if (!paging || !fetcher) return;
    const entry = getSlot().entries[key];
    const current = port.read(key) as ReplicaPagedData<unknown, unknown> | undefined;
    if (!current || loadingMore.has(key)) return;
    if (paging.mode === 'cursor' && entry?.source === 'storage') return;
    const params = (entry?.params ?? fallbackParams) as TParams | undefined;
    if (params === undefined) return;
    const cursor = getNextPageCursor(current, at(key));
    if (cursor === null || cursor === undefined) return;

    const query = entry?.query;
    const scope = resource.scope.get();
    const depth = current.currentPage;
    const setLoading = (patch: object) =>
      update(key, (data) => data && ({ ...data, ...patch } as TData), { persist: false });

    loadingMore.add(key);
    setLoading({ isLoadingMore: true, loadMoreError: undefined });
    const isCurrent = () => {
      const latest = port.read(key) as ReplicaPagedData<unknown, unknown> | undefined;
      return (
        resource.scope.get() === scope &&
        getSlot().entries[key]?.query === query &&
        latest?.currentPage === depth
      );
    };
    try {
      const page = (await fetcher(params, cursor)) as unknown as ReplicaPageResult<
        unknown,
        unknown
      >;
      if (!isCurrent()) return void setLoading({ isLoadingMore: false });
      update(
        key,
        (data) => data && (applyNextPage(data as any, page, at(key), pagingCtx) as TData),
        { persist: (paging.persist?.pages ?? 1) > 1 },
      );
    } catch (error) {
      setLoading({ isLoadingMore: false, loadMoreError: isCurrent() ? error : undefined });
    } finally {
      loadingMore.delete(key);
    }
  };

  /** Insert rows at the head (new / streamed items). */
  const insertHead = <TItem>(key: string, items: TItem[], { persist = false } = {}) =>
    paging
      ? update(key, (data) => data && (insertHeadItems(data as any, items, at(key)) as TData), {
          persist,
        })
      : false;

  /** Drop loaded pages, keeping the head (e.g. after an edit inside older pages). */
  const collapse = (key: string) =>
    paging
      ? update(key, (data) => data && (collapseToHead(data as any, at(key)) as TData), {
          persist: false,
        })
      : false;

  return {
    collapse,
    insertHead,
    keepClientOnlyRows,
    loadMore,
    mergeHead,
    toPersisted,
    viewMatchesFields,
  };
};
