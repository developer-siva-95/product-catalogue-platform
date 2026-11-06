/** Inline loading indicator with an accessible label. */
export function Spinner({ label = 'Loading', size = 26 }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
    />
  );
}

export function LoadingBlock({ label = 'Loading…' }) {
  return (
    <div className="spinner-block" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export default Spinner;
