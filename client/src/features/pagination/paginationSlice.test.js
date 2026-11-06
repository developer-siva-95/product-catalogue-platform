import { describe, expect, it } from 'vitest';
import reducer, { adminProductLimitChanged, adminProductPageChanged } from './paginationSlice.js';

const initial = { adminProductPage: 1, adminProductLimit: 10 };

describe('paginationSlice', () => {
  it('starts on the first admin page', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual(initial);
  });

  it('holds no storefront cursor (it belongs to the RTK Query cache)', () => {
    expect(Object.keys(initial)).toEqual(['adminProductPage', 'adminProductLimit']);
  });

  it('clamps the admin page to at least 1', () => {
    expect(reducer(initial, adminProductPageChanged(0)).adminProductPage).toBe(1);
    expect(reducer(initial, adminProductPageChanged(-4)).adminProductPage).toBe(1);
    expect(reducer(initial, adminProductPageChanged('abc')).adminProductPage).toBe(1);
    expect(reducer(initial, adminProductPageChanged(3)).adminProductPage).toBe(3);
  });

  it('resets to page 1 when the page size changes', () => {
    const state = reducer(
      reducer(initial, adminProductPageChanged(4)),
      adminProductLimitChanged(25),
    );
    expect(state.adminProductLimit).toBe(25);
    expect(state.adminProductPage).toBe(1);
  });

  it('falls back to the default page size for junk input', () => {
    expect(reducer(initial, adminProductLimitChanged('nope')).adminProductLimit).toBe(10);
  });
});
