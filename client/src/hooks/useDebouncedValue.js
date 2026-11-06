import { useEffect, useState } from 'react';

/**
 * Debounces a fast-changing value.
 *
 * The storefront search box uses this so typing does not fire a request per
 * keystroke. The returned `settled` flag lets callers distinguish "the user is
 * still typing" from "the value is final", which is what keeps the UI from
 * showing a premature empty state.
 *
 * Note: the effect cleanup cancels the pending timer, so an unmount mid-debounce
 * cannot set state on an unmounted component.
 *
 * @template T
 * @param {T} value
 * @param {number} delayMs
 * @returns {T}
 */
export function useDebouncedValue(value, delayMs = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value);
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export default useDebouncedValue;
