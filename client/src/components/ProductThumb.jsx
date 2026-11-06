import { initialsOf } from '../utils/format.js';

/**
 * Table thumbnail with a deliberate fallback.
 *
 * Products without an uploaded image (many seeded ones, and every product created
 * before its first upload) get an initials tile rather than an empty grey square,
 * so dense admin tables stay scannable.
 */
export function ProductThumb({ src, title = '', size = 48 }) {
  if (src) {
    return (
      <img className="table__thumb" src={src} alt="" width={size} height={size} loading="lazy" />
    );
  }
  return (
    <span className="table__thumb table__thumb--placeholder" aria-hidden="true">
      {initialsOf(title)}
    </span>
  );
}

export default ProductThumb;
