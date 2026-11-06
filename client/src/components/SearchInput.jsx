import { useEffect, useRef, useState } from 'react';
import { SEARCH_MIN_LENGTH } from '../utils/constants.js';

/**
 * Debounced search box.
 *
 * Model: the **prop is the truth**, and local state holds only the text the user
 * is still typing (`pending`). While nothing is pending the input mirrors the prop
 * exactly, so an external change (a deep link, "clear filters", browser back) can
 * never be fought by a stale debounce — which is what used to wipe `?search=` on
 * arrival.
 *
 * Commit rules:
 *  - only when the pending text settles (debounce);
 *  - only when it differs from the current value;
 *  - only when it is empty (clearing) or at least `minLength` characters, so a
 *    single stray keypress cannot fire a request.
 */
export function SearchInput({
  value,
  onCommit,
  placeholder = 'Search products…',
  label = 'Search products',
  debounceMs = 350,
  minLength = SEARCH_MIN_LENGTH,
}) {
  const current = value ?? '';
  /** `null` means "not editing": the input mirrors the prop. */
  const [pending, setPending] = useState(null);
  const displayValue = pending ?? current;
  const lastCurrent = useRef(current);

  // Only an *actual* change of the prop counts as external (typing must not
  // cancel itself), and it abandons whatever was being typed.
  useEffect(() => {
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    setPending(null);
  }, [current]);

  useEffect(() => {
    if (pending === null) return undefined;

    const trimmed = pending.trim();
    const timer = setTimeout(() => {
      setPending(null);
      if (trimmed === current) return;
      if (trimmed.length > 0 && trimmed.length < minLength) return;
      onCommit(trimmed);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [pending, current, debounceMs, minLength, onCommit]);

  return (
    <div className="toolbar__search">
      <span className="toolbar__search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        type="search"
        className="input"
        value={displayValue}
        onChange={(event) => setPending(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
      />
      {displayValue ? (
        <button
          type="button"
          className="toolbar__search-clear"
          onClick={() => {
            setPending(null);
            onCommit('');
          }}
          aria-label="Clear search"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default SearchInput;
