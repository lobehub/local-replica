/**
 * The browser signals the default driver schedules on. Each reads as "visible"
 * and "online" outside a browser (SSR, a worker, React Native), where there is
 * no focus or connectivity event to revalidate on.
 */

export const isDocumentHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Call `onFocus` when the page regains focus or becomes visible, and
 * `onReconnect` when the browser comes back online. Returns the unsubscribe.
 */
export const watchEnvironment = ({
  onFocus,
  onReconnect,
}: {
  onFocus: () => void;
  onReconnect: () => void;
}) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const focus = () => {
    if (!isDocumentHidden()) onFocus();
  };
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', focus);
  window.addEventListener('online', onReconnect);
  return () => {
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', focus);
    window.removeEventListener('online', onReconnect);
  };
};
