import { describe, expect, it } from 'vitest';
import reducer, {
  passwordRotationCompleted,
  selectAuthInitialized,
  selectCurrentUser,
  selectIsAdmin,
  selectIsAuthenticated,
  selectMustChangePassword,
  sessionCleared,
  sessionEstablished,
  sessionInitialized,
  sessionLoading,
} from './authSlice.js';

const initial = { user: null, status: 'idle', initialized: false };
const admin = {
  id: 'u1',
  name: 'Ada Admin',
  email: 'admin@catalogue.com',
  role: 'admin',
  mustChangePassword: true,
};

const stateAfter = (user) => reducer(initial, sessionEstablished(user));

describe('authSlice', () => {
  it('starts uninitialised and anonymous', () => {
    const state = reducer(undefined, { type: '@@init' });
    expect(state).toEqual(initial);
    expect(selectIsAuthenticated({ auth: state })).toBe(false);
  });

  it('marks the session as loading without declaring anonymity', () => {
    const state = reducer(initial, sessionLoading());
    expect(state.status).toBe('loading');
    expect(state.initialized).toBe(false);
  });

  it('stores the user and marks the session initialised', () => {
    const state = stateAfter(admin);
    expect(state.status).toBe('authenticated');
    expect(state.initialized).toBe(true);
    expect(selectIsAuthenticated({ auth: state })).toBe(true);
    expect(selectIsAdmin({ auth: state })).toBe(true);
    expect(selectMustChangePassword({ auth: state })).toBe(true);
  });

  it('identifies non-admin accounts', () => {
    const state = stateAfter({ ...admin, role: 'customer' });
    expect(selectIsAdmin({ auth: state })).toBe(false);
  });

  it('clears the session on logout and stays initialised', () => {
    const state = reducer(stateAfter(admin), sessionCleared());
    expect(state.user).toBeNull();
    expect(state.status).toBe('anonymous');
    expect(state.initialized).toBe(true);
    expect(selectIsAuthenticated({ auth: state })).toBe(false);
  });

  it('settles an idle session as anonymous', () => {
    const state = reducer(initial, sessionInitialized());
    expect(state.status).toBe('anonymous');
    expect(state.initialized).toBe(true);
    expect(selectAuthInitialized({ auth: state })).toBe(true);
  });

  it('does not downgrade an already authenticated session when initialised again', () => {
    const state = reducer(stateAfter(admin), sessionInitialized());
    expect(state.status).toBe('authenticated');
    expect(selectCurrentUser({ auth: state }).email).toBe('admin@catalogue.com');
  });

  it('clears the forced-rotation flag after a successful password change', () => {
    const state = reducer(stateAfter(admin), passwordRotationCompleted());
    expect(selectMustChangePassword({ auth: state })).toBe(false);
    // Everything else is untouched.
    expect(state.user.email).toBe('admin@catalogue.com');
    expect(state.status).toBe('authenticated');
  });

  it('ignores the rotation action when there is no user', () => {
    expect(reducer(initial, passwordRotationCompleted())).toEqual(initial);
  });
});
