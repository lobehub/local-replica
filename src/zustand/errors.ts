/** `slice.fetch` was asked to fetch for a scope that is no longer active. */
export class ReplicaScopeChangedError extends Error {
  constructor(name: string, scope: string) {
    super(`[replica] ${name}: scope ${scope} is no longer active`);
    this.name = 'ReplicaScopeChangedError';
  }
}
