import { createSlice, nanoid } from '@reduxjs/toolkit';

/**
 * Global UI state: toasts and the global error banner.
 * Toasts are capped so a burst of failures cannot flood the viewport.
 */
const MAX_TOASTS = 4;

const initialState = {
  toasts: [],
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toastAdded: {
      reducer(state, action) {
        state.toasts.push(action.payload);
        if (state.toasts.length > MAX_TOASTS) state.toasts.shift();
      },
      prepare({ message, type = 'info', durationMs = 4500 }) {
        return { payload: { id: nanoid(), message, type, durationMs } };
      },
    },
    toastDismissed(state, action) {
      state.toasts = state.toasts.filter((toast) => toast.id !== action.payload);
    },
    toastsCleared(state) {
      state.toasts = [];
    },
  },
});

export const { toastAdded, toastDismissed, toastsCleared } = uiSlice.actions;

export const selectToasts = (state) => state.ui.toasts;

/** Convenience thunks keep components free of toast plumbing. */
export const showSuccess = (message) => toastAdded({ message, type: 'success' });
export const showError = (message) => toastAdded({ message, type: 'error' });
export const showInfo = (message) => toastAdded({ message, type: 'info' });

export default uiSlice.reducer;
