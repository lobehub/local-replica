/**
 * How entities (e.g. topics) appear inside a non-paged resource value. Paged
 * resources get this for free from `paging.getId`. Build one with
 * `singleEntity` (a detail value), `arrayEntity` (a plain list) or by hand for
 * nested shapes (grouped lists).
 */
export interface ReplicaEntityAdapter<TData, TItem> {
  /** Whether `data` holds the entity. */
  has: (data: TData, id: string) => boolean;
  /**
   * Map the entity inside `data` (`fn` returning `undefined` deletes it).
   * Return `data` itself when nothing changed, or `undefined` when the whole
   * value goes away with the entity (a detail value).
   */
  map: (data: TData, id: string, fn: (item: TItem) => TItem | undefined) => TData | undefined;
}
