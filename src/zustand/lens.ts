import type { ReplicaPagedData } from '../core/paging/types';
import type { ReplicaViewWrite } from '../core/state/reducer';

/**
 * One `key` write in a batched lens update (see {@link ReplicaLens.setMany}).
 */
export interface ReplicaViewSet<TData> {
  data: TData | undefined;
  key: string;
}

/**
 * Where the materialized value lives in the domain store. Selectors keep
 * reading this location; the slice is the only writer.
 */
export interface ReplicaLens<TStore, TData> {
  clear: (state: TStore) => Partial<TStore>;
  get: (state: TStore, key: string) => TData | undefined;
  /** Enumerate loaded keys (needed for entity propagation). */
  keys?: (state: TStore) => string[];
  set: (state: TStore, key: string, data: TData | undefined) => Partial<TStore>;
  /**
   * Apply several key writes in one pass — one clone of the backing field
   * instead of one per key. Optional: the slice falls back to repeated `set`
   * when a lens does not implement it.
   */
  setMany?: (state: TStore, entries: ReplicaViewSet<TData>[]) => Partial<TStore>;
}

/**
 * Apply every view write as ONE host update, so subscribers never observe a
 * view out of step with its bookkeeping. Consecutive key writes go through
 * the lens' `setMany` when it has one, so seeding N rows clones the backing
 * field once instead of N times.
 */
export const applyLensWrites = <TStore, TData>(
  view: ReplicaLens<TStore, TData>,
  state: TStore,
  writes: ReplicaViewWrite<TData>[],
): Partial<TStore> => {
  let patch: Partial<TStore> = {};
  let current = state;
  let pending: ReplicaViewSet<TData>[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const entries = pending;
    pending = [];
    if (view.setMany && entries.length > 1) {
      const next = view.setMany(current, entries);
      patch = { ...patch, ...next };
      current = { ...current, ...next };
      return;
    }
    for (const entry of entries) {
      const next = view.set(current, entry.key, entry.data);
      patch = { ...patch, ...next };
      current = { ...current, ...next };
    }
  };

  for (const write of writes) {
    if ('type' in write) {
      flush();
      const next = view.clear(current);
      patch = { ...patch, ...next };
      current = { ...current, ...next };
    } else {
      pending.push({ data: write.data, key: write.key });
    }
  }
  flush();
  return patch;
};

/** Lens for the common case: a `Record<key, TData>` field on the store. */
export const recordLens = <TStore, TData>(
  field: keyof TStore & string,
): ReplicaLens<TStore, TData> => ({
  clear: () => ({ [field]: {} }) as Partial<TStore>,
  get: (state, key) => (state[field] as Record<string, TData> | undefined)?.[key],
  keys: (state) => Object.keys((state[field] as Record<string, TData> | undefined) ?? {}),
  set: (state, key, data) => {
    const next = { ...(state[field] as Record<string, TData> | undefined) };
    if (data === undefined) delete next[key];
    else next[key] = data;
    return { [field]: next } as Partial<TStore>;
  },
  setMany: (state, entries) => {
    // One clone of the record, then every key — a list refresh seeds N groups
    // in a single copy instead of N.
    const next = { ...(state[field] as Record<string, TData> | undefined) };
    for (const { key, data } of entries) {
      if (data === undefined) delete next[key];
      else next[key] = data;
    }
    return { [field]: next } as Partial<TStore>;
  },
});

/**
 * Lens for a paged view split across store fields: the rows stay where
 * existing readers expect them (`itemsField[key]`, a plain array), the paging
 * bookkeeping lives in `metaField[key]`, and `derive` recomputes fields built
 * from the rows (e.g. a parsed display list) in the same commit — so a derived
 * field is never one frame behind its rows.
 *
 * Rows seeded without bookkeeping (by code outside the replica) read as a
 * single head page.
 */
export const splitPagedLens = <TStore, TItem, TCursor = unknown>({
  clearDerived,
  derive,
  itemsField,
  metaField,
}: {
  /** Derived fields to reset on a scope change. */
  clearDerived?: () => Partial<TStore>;
  /** Fields computed from an entry's rows (`undefined` = the entry is gone). */
  derive?: (state: TStore, key: string, items: TItem[] | undefined) => Partial<TStore>;
  itemsField: keyof TStore & string;
  metaField: keyof TStore & string;
}): ReplicaLens<TStore, ReplicaPagedData<TItem, TCursor>> => {
  type Meta = Omit<ReplicaPagedData<TItem, TCursor>, 'items'>;
  const NO_META = {} as Meta;
  // Same rows + same bookkeeping → the same view object, so the engine's
  // reference checks see "unchanged".
  const views = new WeakMap<TItem[], WeakMap<Meta, ReplicaPagedData<TItem, TCursor>>>();
  const remember = (items: TItem[], meta: Meta, view: ReplicaPagedData<TItem, TCursor>) => {
    let byMeta = views.get(items);
    if (!byMeta) views.set(items, (byMeta = new WeakMap()));
    byMeta.set(meta, view);
    return view;
  };
  const rowsOf = (state: TStore) => (state[itemsField] ?? {}) as Record<string, TItem[]>;
  const metaOf = (state: TStore) => (state[metaField] ?? {}) as Record<string, Meta>;

  return {
    clear: () => ({ [itemsField]: {}, [metaField]: {}, ...clearDerived?.() }) as Partial<TStore>,
    get: (state, key) => {
      const items = rowsOf(state)[key];
      if (!items) return undefined;
      const meta = metaOf(state)[key] ?? NO_META;
      const cached = views.get(items)?.get(meta);
      if (cached) return cached;
      const view =
        meta === NO_META
          ? { currentPage: 0, hasMore: true, items, pageSize: items.length }
          : { ...meta, items };
      return remember(items, meta, view);
    },
    keys: (state) => Object.keys(rowsOf(state)),
    set: (state, key, data) => {
      const rows = { ...rowsOf(state) };
      const metas = { ...metaOf(state) };
      if (data === undefined) {
        delete rows[key];
        delete metas[key];
      } else {
        const { items, ...meta } = data;
        rows[key] = items;
        metas[key] = meta;
        remember(items, meta, data);
      }
      const next = { ...state, [itemsField]: rows, [metaField]: metas } as TStore;
      return {
        [itemsField]: rows,
        [metaField]: metas,
        ...derive?.(next, key, data?.items),
      } as Partial<TStore>;
    },
  };
};
