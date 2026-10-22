/** Persisted row key: one row per entry key and query. */
export const replicaStorageKey = (key: string, query?: string) => (query ? `${key}?${query}` : key);

/**
 * Whether `storageKey` is a persisted row of entry `key`, under any query.
 *
 * Entry keys are free-form, so a `?` prefix alone cannot tell `foo` + a query
 * from a plain entry `foo?bar`. A row only counts as a variant when it is
 * exactly `replicaStorageKey(key, query)` for a query this module could have
 * written: the rest after `key?` must be a canonical `stableQueryKey` (it
 * parses as JSON and serializes back to itself). Row keys and the index keep
 * their existing flat format, so rows already persisted on devices match the
 * same way.
 */
export const isReplicaStorageKeyOf = (storageKey: string, key: string): boolean => {
  if (storageKey === key) return true;
  if (!storageKey.startsWith(`${key}?`)) return false;
  const query = storageKey.slice(key.length + 1);
  try {
    return stableQueryKey(JSON.parse(query)) === query;
  } catch {
    return false;
  }
};

/** Deterministic JSON: sorted keys, `undefined` dropped. */
export const stableQueryKey = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]),
        )
      : item,
  ) ?? '';
