import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  fieldErrorsFromApi,
  formatDate,
  formatPrice,
  initialsOf,
  stockBadgeClass,
  availableStock,
  describeStock,
} from './format.js';

describe('formatPrice', () => {
  it('formats rupees without decimals', () => {
    expect(formatPrice(2499)).toMatch(/2,499/);
    expect(formatPrice('18999')).toMatch(/18,999/);
  });

  it('returns a dash for missing or invalid input', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
    expect(formatPrice('abc')).toBe('—');
  });

  it('formats zero as a real price', () => {
    expect(formatPrice(0)).toMatch(/0/);
  });
});

describe('formatDate', () => {
  it('formats an ISO date', () => {
    expect(formatDate('2026-01-05T10:00:00.000Z')).toMatch(/2026/);
  });

  it('returns a dash for missing or invalid input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('stockBadgeClass', () => {
  it.each([
    ['in_stock', 'badge badge--success'],
    ['low_stock', 'badge badge--warning'],
    ['out_of_stock', 'badge badge--danger'],
    ['something-else', 'badge badge--neutral'],
    [undefined, 'badge badge--neutral'],
  ])('maps %s to a badge class', (status, expected) => {
    expect(stockBadgeClass(status)).toBe(expected);
  });
});

describe('availableStock', () => {
  it.each([
    [0, 0],
    [7, 7],
    ['12', 12],
    [3.9, 3],
  ])('normalises %s to %s', (input, expected) => {
    expect(availableStock(input)).toBe(expected);
  });

  it.each([[undefined], [null], [''], ['many'], [-1], [Number.NaN]])(
    'returns null for the unusable value %s',
    (input) => {
      expect(availableStock(input)).toBeNull();
    },
  );
});

describe('describeStock', () => {
  it('prefers the status the API returned', () => {
    expect(describeStock('low_stock', 9).status).toBe('low_stock');
    expect(describeStock('low_stock', 9).label).toBe('Low stock · 9 left');
  });

  it('labels the three public states for cards', () => {
    expect(describeStock('in_stock', 40).label).toBe('40 in stock');
    expect(describeStock('low_stock', 2).label).toBe('Low stock · 2 left');
    expect(describeStock('out_of_stock', 0).label).toBe('Out of stock');
  });

  it('labels the detail view with an explicit availability sentence', () => {
    expect(describeStock('in_stock', 40, 'detail').label).toBe('In stock · 40 available');
  });

  it('never recomputes the low-stock threshold on the client', () => {
    // A quantity of 3 with no status must not be labelled "low stock": the server
    // owns that threshold.
    const info = describeStock(undefined, 3);
    expect(info.status).toBe('in_stock');
    expect(info.label).toBe('3 in stock');
  });

  it('reports unknown stock without inventing availability', () => {
    expect(describeStock(undefined, undefined)).toEqual({
      status: 'unknown',
      quantity: null,
      label: 'Stock unavailable',
      badgeClass: 'badge badge--neutral',
    });
  });
});

describe('errorMessage', () => {
  it('unwraps the API error envelope', () => {
    expect(
      errorMessage({
        status: 409,
        data: { error: { code: 'STALE_RESOURCE', message: 'Changed.' } },
      }),
    ).toBe('Changed.');
  });

  it('falls back for network failures', () => {
    expect(errorMessage({ status: 'FETCH_ERROR', error: 'x' }, 'fallback')).toMatch(
      /cannot reach the server/i,
    );
  });

  it('uses the fallback when the body has no message', () => {
    expect(errorMessage({ status: 500, data: {} }, 'fallback')).toBe('fallback');
    expect(errorMessage(null, 'fallback')).toBe('fallback');
  });

  it('passes a plain-text body through', () => {
    expect(errorMessage({ status: 502, data: 'Bad gateway' })).toBe('Bad gateway');
  });

  it('still understands a top-level message', () => {
    expect(errorMessage({ status: 400, data: { message: 'Nope' } })).toBe('Nope');
  });
});

describe('fieldErrorsFromApi', () => {
  it('maps validation details onto field names', () => {
    const errors = fieldErrorsFromApi({
      status: 422,
      data: {
        error: {
          code: 'VALIDATION_ERROR',
          details: [
            { path: 'body.price', message: 'Price must be positive' },
            { path: 'body.title', message: 'Title is required' },
          ],
        },
      },
    });
    expect(errors).toEqual({ price: 'Price must be positive', title: 'Title is required' });
  });

  it('keeps the first message per field', () => {
    const errors = fieldErrorsFromApi({
      data: {
        error: {
          details: [
            { path: 'price', message: 'first' },
            { path: 'price', message: 'second' },
          ],
        },
      },
    });
    expect(errors.price).toBe('first');
  });

  it('returns an empty map when there are no details', () => {
    expect(fieldErrorsFromApi({ data: { error: {} } })).toEqual({});
    expect(fieldErrorsFromApi()).toEqual({});
  });
});

describe('initialsOf', () => {
  it('takes up to two initials', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('Prince')).toBe('P');
    expect(initialsOf('')).toBe('');
  });
});
