import Modal from './Modal.jsx';

/**
 * Destructive-action confirmation.
 * Focus starts on "Cancel" (the safe choice) and the confirm button names the
 * action, which is what prevents accidental deletions.
 */
export function ConfirmDialog({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
  tone = 'danger',
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={busy}
            autoFocus
          >
            {cancelLabel}
          </button>
          <button type="button" className={`btn btn--${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="btn__spinner" aria-hidden="true" /> : null}
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-muted">{message}</p>
    </Modal>
  );
}

export default ConfirmDialog;
