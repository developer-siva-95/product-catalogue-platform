import { describeStock } from '../utils/format.js';

/**
 * Public stock indicator, shared by the listing cards and the detail page so both
 * views always agree (`describeStock` is the single source of truth).
 *
 * The label carries the *public* quantity only — never reserved, back-order or
 * supplier figures, which the storefront API does not expose either.
 *
 * @param {{
 *   stockStatus?: string,
 *   stock?: number|string,
 *   variant?: 'card' | 'detail',
 *   className?: string
 * }} props
 */
export function StockBadge({ stockStatus, stock, variant = 'card', className = '' }) {
  const info = describeStock(stockStatus, stock, variant);

  return (
    <span
      className={`${info.badgeClass} stock-badge stock-badge--${variant}${
        className ? ` ${className}` : ''
      }`}
      data-stock-status={info.status}
      data-stock-quantity={info.quantity ?? undefined}
      title={info.label}
    >
      <span className="stock-badge__dot" aria-hidden="true" />
      {info.label}
    </span>
  );
}

export default StockBadge;
