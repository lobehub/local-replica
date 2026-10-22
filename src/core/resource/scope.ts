import type { ReplicaScope } from './types';

/**
 * A fixed identity partition. The default for apps without accounts; an app
 * with sign-in passes a scope derived from the signed-in user / workspace so
 * one browser profile never mixes two identities' rows.
 */
export const staticReplicaScope = (scope = 'default'): ReplicaScope => ({
  canPersist: () => true,
  get: () => scope,
  use: () => scope,
});
