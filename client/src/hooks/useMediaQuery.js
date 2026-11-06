import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query from React.
 *
 * Used for decisions that CSS alone cannot make: the mobile filter drawer must not
 * keep its controls in the tab order while it is closed, which `display: none`
 * cannot guarantee across browsers, so the component needs to know the breakpoint.
 *
 * `useSyncExternalStore` is the right primitive here — the media query *is* an
 * external store, so there is no effect, no state to keep in sync and no
 * tearing when the list changes between render and paint.
 *
 * Returns `false` when `matchMedia` is unavailable (jsdom without a stub, SSR),
 * which keeps the desktop layout as the safe default.
 *
 * @param {string} query e.g. `'(max-width: 900px)'`
 * @returns {boolean} whether the query currently matches
 */
export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onStoreChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }

      const list = window.matchMedia(query);
      // Safari < 14 only implements the deprecated listener API.
      if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', onStoreChange);
        return () => list.removeEventListener('change', onStoreChange);
      }
      list.addListener(onStoreChange);
      return () => list.removeListener(onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => readMatch(query), [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

function readMatch(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

export default useMediaQuery;
