import { describe, expect, it } from 'vitest';
import reducer, {
  countActiveFilters,
  filterBrandToggled,
  filterCategoryToggled,
  filterPriceChanged,
  filterSearchChanged,
  filterSortChanged,
  filtersReplaced,
  filtersReset,
} from './storefrontFiltersSlice.js';
import { PRODUCT_SORTS } from '../../utils/constants.js';

const initial = {
  search: '',
  brand: '',
  category: '',
  minPrice: '',
  maxPrice: '',
  sort: PRODUCT_SORTS.NEWEST,
};

describe('storefrontFiltersSlice', () => {
  it('exposes the documented initial state', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual(initial);
  });

  it('toggles a brand on and back off', () => {
    const selected = reducer(initial, filterBrandToggled('brand-1'));
    expect(selected.brand).toBe('brand-1');
    expect(reducer(selected, filterBrandToggled('brand-1')).brand).toBe('');
  });

  it('switches directly between brands', () => {
    const a = reducer(initial, filterBrandToggled('brand-1'));
    expect(reducer(a, filterBrandToggled('brand-2')).brand).toBe('brand-2');
  });

  it('toggles a category independently of the brand', () => {
    const state = reducer(
      reducer(initial, filterBrandToggled('brand-1')),
      filterCategoryToggled('cat-1'),
    );
    expect(state.brand).toBe('brand-1');
    expect(state.category).toBe('cat-1');
  });

  it('replaces the price range atomically and accepts an empty range', () => {
    const set = reducer(initial, filterPriceChanged({ minPrice: '100', maxPrice: '500' }));
    expect(set.minPrice).toBe('100');
    expect(set.maxPrice).toBe('500');
    const cleared = reducer(set, filterPriceChanged({}));
    expect(cleared.minPrice).toBe('');
    expect(cleared.maxPrice).toBe('');
  });

  it('keeps the price inputs as strings (they come from text fields)', () => {
    expect(reducer(initial, filterPriceChanged({ minPrice: '0' })).minPrice).toBe('0');
  });

  it('normalises an unknown sort back to newest', () => {
    expect(reducer(initial, filterSortChanged('bogus')).sort).toBe(PRODUCT_SORTS.NEWEST);
    expect(reducer(initial, filterSortChanged('price_asc')).sort).toBe('price_asc');
  });

  it('replaces the whole set from the URL, filling missing keys', () => {
    const state = reducer(initial, filtersReplaced({ search: 'lamp', brand: 'b1' }));
    expect(state).toEqual({ ...initial, search: 'lamp', brand: 'b1' });
  });

  it('resets every filter', () => {
    const dirty = reducer(
      reducer(initial, filterSearchChanged('desk')),
      filterPriceChanged({ minPrice: '10', maxPrice: '20' }),
    );
    expect(reducer(dirty, filtersReset())).toEqual(initial);
  });

  it('counts the price range as a single active filter', () => {
    expect(
      countActiveFilters({
        search: 'lamp',
        brand: 'b1',
        category: '',
        minPrice: '10',
        maxPrice: '20',
        sort: '-createdAt',
      }),
    ).toBe(3);
  });

  it('counts a half-open price range too', () => {
    expect(countActiveFilters({ ...initial, minPrice: '10' })).toBe(1);
    expect(countActiveFilters({ ...initial, maxPrice: '10' })).toBe(1);
  });

  it('does not count the default sort as a filter', () => {
    expect(countActiveFilters({ ...initial, sort: PRODUCT_SORTS.NEWEST })).toBe(0);
  });
});
