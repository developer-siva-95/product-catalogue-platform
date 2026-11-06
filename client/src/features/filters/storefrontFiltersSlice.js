import { createSlice } from '@reduxjs/toolkit';
import { PRODUCT_SORTS } from '../../utils/constants.js';

/**
 * Global storefront filters.
 *
 * Lean by design: this holds *UI intent* (what the shopper selected). Product
 * data, pagination cursors and loading flags stay in RTK Query / the pagination
 * slice. The URL is the durable copy — the storefront keeps both in sync so a
 * shared link or a browser-back restores the exact view.
 */
const initialState = {
  search: '',
  brand: '',
  category: '',
  minPrice: '',
  maxPrice: '',
  sort: PRODUCT_SORTS.NEWEST,
};

/** Number of filters that are actually constraining the result set. */
export function countActiveFilters(filters) {
  let count = 0;
  if (filters.search) count += 1;
  if (filters.brand) count += 1;
  if (filters.category) count += 1;
  if (filters.minPrice !== '' || filters.maxPrice !== '') count += 1;
  return count;
}

const filtersSlice = createSlice({
  name: 'filters',
  initialState,
  reducers: {
    filterSearchChanged(state, action) {
      state.search = action.payload ?? '';
    },
    filterBrandToggled(state, action) {
      state.brand = state.brand === action.payload ? '' : action.payload;
    },
    filterCategoryToggled(state, action) {
      state.category = state.category === action.payload ? '' : action.payload;
    },
    filterPriceChanged(state, action) {
      state.minPrice = action.payload.minPrice ?? '';
      state.maxPrice = action.payload.maxPrice ?? '';
    },
    filterSortChanged(state, action) {
      // Only documented sorts are accepted; anything else falls back to newest so
      // the server never receives an unsupported `sort` value.
      const allowed = Object.values(PRODUCT_SORTS);
      state.sort = allowed.includes(action.payload) ? action.payload : PRODUCT_SORTS.NEWEST;
    },
    filtersReplaced(state, action) {
      return { ...initialState, ...action.payload };
    },
    filtersReset() {
      return initialState;
    },
  },
});

export const {
  filterSearchChanged,
  filterBrandToggled,
  filterCategoryToggled,
  filterPriceChanged,
  filterSortChanged,
  filtersReplaced,
  filtersReset,
} = filtersSlice.actions;

export const selectFilters = (state) => state.filters;
export const selectActiveFilterCount = (state) => countActiveFilters(state.filters);

export default filtersSlice.reducer;
