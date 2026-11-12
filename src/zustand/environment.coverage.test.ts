/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';

import { isDocumentHidden, isOffline, watchEnvironment } from './environment';

describe('environment outside a browser', () => {
  it('reads as visible and online, and has nothing to watch', () => {
    expect(isDocumentHidden()).toBe(false);
    expect(isOffline()).toBe(false);

    const onFocus = vi.fn();
    const unwatch = watchEnvironment({ onFocus, onReconnect: vi.fn() });
    expect(unwatch()).toBeUndefined();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('needs a document as well as a window', () => {
    vi.stubGlobal('window', {});
    expect(watchEnvironment({ onFocus: vi.fn(), onReconnect: vi.fn() })()).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
