import { createSlice } from '@reduxjs/toolkit';

/**
 * Admin pagination tokens.
 *
 * The storefront no longer keeps a cursor here: a cursor is only meaningful for the
 * cache entry that holds the pages it addresses, so the storefront derives its
 * paging position from the RTK Query cache itself (see `StorefrontPage`). Keeping a
 * cursor in Redux outlived the cached pages and replayed page 2 into an empty
 * cache. Admin page numbers are plain offsets (not cursors), survive navigating
 * into an edit form and back, and still belong in the store.
 */
const initialState = {
  adminProductPage: 1,
  adminProductLimit: 10,
};

const paginationSlice = createSlice({
  name: 'pagination',
  initialState,
  reducers: {
    adminProductPageChanged(state, action) {
      state.adminProductPage = Math.max(1, Number(action.payload) || 1);
    },
    adminProductLimitChanged(state, action) {
      state.adminProductLimit = Number(action.payload) || 10;
      state.adminProductPage = 1;
    },
  },
});

export const { adminProductPageChanged, adminProductLimitChanged } = paginationSlice.actions;

export const selectAdminProductPage = (state) => state.pagination.adminProductPage;
export const selectAdminProductLimit = (state) => state.pagination.adminProductLimit;

export default paginationSlice.reducer;
