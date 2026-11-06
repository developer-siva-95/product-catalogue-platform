import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { selectToasts, toastDismissed } from '../features/ui/uiSlice.js';

/**
 * Renders the transient notifications from the UI slice.
 * Each toast auto-dismisses; `role="status"` + `aria-live` announces it to screen
 * readers without stealing focus.
 */
function Toast({ toast }) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const timer = setTimeout(() => dispatch(toastDismissed(toast.id)), toast.durationMs ?? 4500);
    return () => clearTimeout(timer);
  }, [dispatch, toast.id, toast.durationMs]);

  return (
    <div className={`toast toast--${toast.type}`} role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button
        type="button"
        className="toast__close"
        onClick={() => dispatch(toastDismissed(toast.id))}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useAppSelector(selectToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

export default Toaster;
