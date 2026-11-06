import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { apiSlice } from '../api/apiSlice.js';
import authReducer from '../features/auth/authSlice.js';
import filtersReducer from '../features/filters/storefrontFiltersSlice.js';
import paginationReducer from '../features/pagination/paginationSlice.js';
import uiReducer from '../features/ui/uiSlice.js';

/**
 * Store composition.
 *
 * Server state lives exclusively in RTK Query (`apiSlice`); the four slices hold
 * only what the server cannot own: the session mirror, storefront filters,
 * pagination tokens and transient UI (toasts).
 */
export function createAppStore(preloadedState) {
  const store = configureStore({
    reducer: {
      [apiSlice.reducerPath]: apiSlice.reducer,
      auth: authReducer,
      filters: filtersReducer,
      pagination: paginationReducer,
      ui: uiReducer,
    },
    preloadedState,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(apiSlice.middleware),
    devTools: import.meta.env?.DEV ?? false,
  });

  // Enables refetchOnFocus/refetchOnReconnect behaviours when opted into.
  setupListeners(store.dispatch);
  return store;
}

export const store = createAppStore();
export default store;
