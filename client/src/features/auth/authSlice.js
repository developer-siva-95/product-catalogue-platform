import { createSlice } from '@reduxjs/toolkit';

/**
 * Auth is mostly *server* state (owned by RTK Query's `me` endpoint), so this
 * slice only mirrors the minimum the UI needs synchronously: the user identity
 * and the session bootstrap status. Keeping it lean means there is exactly one
 * place that can mark a session as authenticated.
 */
const initialState = {
  user: null,
  /** 'idle' | 'loading' | 'authenticated' | 'anonymous' */
  status: 'idle',
  /** True once the initial /auth/me probe has completed (avoids a login flash). */
  initialized: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionLoading(state) {
      state.status = 'loading';
    },
    sessionEstablished(state, action) {
      state.user = action.payload;
      state.status = 'authenticated';
      state.initialized = true;
    },
    sessionCleared(state) {
      state.user = null;
      state.status = 'anonymous';
      state.initialized = true;
    },
    /**
     * Clears the forced-rotation flag after a successful password change.
     *
     * The flag is server state (it comes back on `/auth/me`), but the router guard
     * reads it synchronously: without this, finishing the change would bounce the
     * user straight back to the change-password screen until a refetch landed.
     */
    passwordRotationCompleted(state) {
      if (state.user) state.user.mustChangePassword = false;
    },
    sessionInitialized(state) {
      state.initialized = true;
      if (state.status === 'loading' || state.status === 'idle') state.status = 'anonymous';
    },
  },
});

export const {
  sessionLoading,
  sessionEstablished,
  sessionCleared,
  sessionInitialized,
  passwordRotationCompleted,
} = authSlice.actions;

export const selectCurrentUser = (state) => state.auth.user;
export const selectAuthStatus = (state) => state.auth.status;
export const selectIsAuthenticated = (state) =>
  state.auth.status === 'authenticated' && Boolean(state.auth.user);
export const selectIsAdmin = (state) => state.auth.user?.role === 'admin';
export const selectMustChangePassword = (state) => Boolean(state.auth.user?.mustChangePassword);
export const selectAuthInitialized = (state) => state.auth.initialized;

export default authSlice.reducer;
