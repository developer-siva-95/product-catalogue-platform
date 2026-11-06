const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const compactFormatter = new Intl.NumberFormat('en-IN', { notation: 'compact' });

export function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return currencyFormatter.format(Number(value));
}

export function formatCompact(value) {
  return compactFormatter.format(Number(value ?? 0));
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Human labels for the stock badges returned by the API. */
export const STOCK_LABELS = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

export function stockBadgeClass(stockStatus) {
  if (stockStatus === 'out_of_stock') return 'badge badge--danger';
  if (stockStatus === 'low_stock') return 'badge badge--warning';
  if (stockStatus === 'in_stock') return 'badge badge--success';
  // Missing or unrecognised status: never claim availability we cannot prove.
  return 'badge badge--neutral';
}

const STOCK_STATUSES = new Set(['in_stock', 'low_stock', 'out_of_stock']);

/**
 * Public available quantity, or `null` when the API did not send a usable number.
 *
 * The storefront only ever reads the public `stock` field — no inventory maths and
 * no threshold logic happens here, because the server owns both. A negative or
 * non-numeric value is treated as unknown rather than rendered as a lie.
 */
export function availableStock(stock) {
  const value = Number(stock);
  if (stock === null || stock === undefined || stock === '' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.floor(value);
}

/**
 * Everything a stock indicator needs, derived from the API's own `stockStatus`
 * and public `stock` quantity.
 *
 * `status` prefers the server's value. Only when it is missing/unrecognised does
 * this fall back to the unambiguous cases (0 → out of stock, >0 → in stock); the
 * low-stock threshold is never recomputed on the client.
 *
 * @param {string|undefined} stockStatus
 * @param {number|string|undefined} stock
 * @param {'card'|'detail'} variant
 * @returns {{ status: string, quantity: number|null, label: string, badgeClass: string }}
 */
export function describeStock(stockStatus, stock, variant = 'card') {
  const quantity = availableStock(stock);
  let status = STOCK_STATUSES.has(stockStatus) ? stockStatus : null;

  if (!status && quantity !== null) {
    status = quantity === 0 ? 'out_of_stock' : 'in_stock';
  }
  if (!status) {
    return {
      status: 'unknown',
      quantity: null,
      label: 'Stock unavailable',
      badgeClass: 'badge badge--neutral',
    };
  }

  let label;
  if (status === 'out_of_stock') {
    label = 'Out of stock';
  } else if (status === 'low_stock') {
    label = quantity === null ? 'Low stock' : `Low stock · ${formatQuantity(quantity)} left`;
  } else if (variant === 'detail') {
    label = quantity === null ? 'In stock' : `In stock · ${formatQuantity(quantity)} available`;
  } else {
    label = quantity === null ? 'In stock' : `${formatQuantity(quantity)} in stock`;
  }

  return { status, quantity, label, badgeClass: stockBadgeClass(status) };
}

/** Locale-grouped quantity (`1,240`), used for the public stock figure. */
export function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-IN').format(Math.floor(number));
}

/**
 * Extracts a human-readable message from an RTK Query error.
 *
 * The API always answers with `{ error: { code, message, details? } }`, so the
 * envelope is unwrapped first; a bare `{ message }` or a plain string body is
 * tolerated for proxies and network-level failures.
 */
export function errorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  const data = error.data;
  if (typeof data === 'string') return data;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (error.status === 'FETCH_ERROR') {
    return 'Cannot reach the server. Check that the API is running and try again.';
  }
  if (error.status === 'PARSING_ERROR') return 'The server returned an unexpected response.';
  return fallback;
}

/** Field-level validation details from the API (path is prefixed, e.g. `body.price`). */
export function fieldErrorsFromApi(error) {
  const details = error?.data?.error?.details;
  if (!Array.isArray(details)) return {};
  const result = {};
  for (const detail of details) {
    if (!detail?.path) continue;
    const field = String(detail.path).split('.').pop();
    if (!result[field]) result[field] = detail.message;
  }
  return result;
}

export function initialsOf(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function toModifierKey(size = 'small') {
  return size;
}
