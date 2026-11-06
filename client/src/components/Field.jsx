import { useId } from 'react';

/**
 * Accessible form field wrapper.
 * Wires `htmlFor`/`id`, `aria-invalid`, `aria-describedby` (hint + error) so
 * validation feedback is announced rather than just coloured red.
 */
export function Field({ label, error, hint, required, children, id: providedId }) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" style={{ color: 'var(--color-danger)' }}>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {typeof children === 'function'
        ? children({
            id,
            'aria-invalid': error ? 'true' : undefined,
            'aria-describedby': describedBy || undefined,
          })
        : children}
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={errorId} role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </span>
      ) : null}
      {describedBy ? <span className="visually-hidden">{describedBy}</span> : null}
    </div>
  );
}

/** Convenience: an <input> already wired to Field's accessibility props. */
export function TextInput({
  id,
  invalid,
  describedBy,
  'aria-describedby': ariaDescribedBy,
  ...props
}) {
  return (
    <input
      id={id}
      className="input"
      aria-invalid={invalid ?? undefined}
      aria-describedby={ariaDescribedBy ?? describedBy ?? undefined}
      {...props}
    />
  );
}

export default Field;
