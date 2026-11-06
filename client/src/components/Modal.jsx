import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog.
 *
 * Implements the behaviours a native <dialog> gives us but with full styling
 * control: Escape closes, focus moves inside on open and is restored on close,
 * Tab is trapped, background scroll is locked, and the dialog is announced via
 * `role="dialog" aria-modal="true"`.
 */
export function Modal({ open, title, description, onClose, children, footer, labelledBy }) {
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  /**
   * Callbacks are kept in a ref so the open/close effect depends on `open` alone.
   * Without this, a parent passing an inline arrow re-runs the effect on every
   * render, and its cleanup yanks focus out of the dialog mid-typing.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const node = dialogRef.current;
    const firstFocusable = node?.querySelector(FOCUSABLE);
    (firstFocusable ?? node)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !node) return;

      const focusable = [...node.querySelectorAll(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = bodyOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const titleId = labelledBy ?? 'modal-title';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? 'modal-description' : undefined}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="modal__header">
          <div>
            <h2 className="modal__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p
                className="text-muted"
                id="modal-description"
                style={{ marginTop: 4, fontSize: 14 }}
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {children}
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export default Modal;
