/**
 * Manual refresh control.
 *
 * One button, one contract, used by every view that owns a product query:
 *
 *  - `onRefresh` is the query hook's `refetch()`, so a click always issues a real
 *    request through the existing RTK Query endpoint (never a cache read);
 *  - `isFetching` drives both the spinner and `disabled`, which is what stops a
 *    double click (or a click during a background refetch) from opening a second
 *    request for the same cache entry;
 *  - `aria-busy` + a polite live region expose the in-progress state to assistive
 *    technology without stealing focus or announcing the whole table again.
 *
 * The component is deliberately dumb: it holds no state and does no fetching, so
 * the data layer stays the single owner of the query lifecycle.
 */
export function RefreshButton({
  onRefresh,
  isFetching = false,
  label = 'Refresh',
  busyLabel = 'Refreshing…',
  disabled = false,
  className = 'btn btn--secondary',
  title,
}) {
  const busy = Boolean(isFetching);
  const isDisabled = busy || disabled;

  return (
    <span className="refresh">
      <button
        type="button"
        className={className}
        onClick={() => {
          if (isDisabled) return;
          onRefresh?.();
        }}
        disabled={isDisabled}
        aria-busy={busy}
        title={title ?? label}
        data-testid="refresh-button"
      >
        {busy ? (
          <span className="btn__spinner" aria-hidden="true" />
        ) : (
          <span className="refresh__icon" aria-hidden="true">
            ⟳
          </span>
        )}
        {label}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {busy ? busyLabel : ''}
      </span>
    </span>
  );
}

export default RefreshButton;
