import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import ProtectedRoute from './ProtectedRoute.jsx';
import { renderWithProviders } from '../test/utils.jsx';
import { createAppStore } from '../app/store.js';
import {
  sessionEstablished,
  sessionInitialized,
  sessionLoading,
} from '../features/auth/authSlice.js';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function buildTree(guardProps = {}) {
  return (
    <>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<p>login screen</p>} />
        <Route path="/change-password" element={<p>change password screen</p>} />
        <Route element={<ProtectedRoute {...guardProps} />}>
          <Route path="/admin" element={<p>admin dashboard</p>} />
        </Route>
        <Route element={<ProtectedRoute requireAdmin={false} allowFlaggedPassword />}>
          <Route path="/change-password-guarded" element={<p>guarded password screen</p>} />
        </Route>
      </Routes>
    </>
  );
}

function storeWith(user, { initialized = true } = {}) {
  const store = createAppStore();
  if (user) store.dispatch(sessionEstablished(user));
  else if (initialized) store.dispatch(sessionInitialized());
  return store;
}

describe('<ProtectedRoute />', () => {
  const admin = {
    id: 'u1',
    email: 'admin@catalogue.com',
    role: 'admin',
    mustChangePassword: false,
  };

  it('waits for the session probe instead of flashing the login screen', () => {
    const store = createAppStore();
    store.dispatch(sessionLoading());
    renderWithProviders(buildTree(), { route: '/admin', store });

    expect(screen.getByRole('status')).toHaveTextContent(/restoring your session/i);
    expect(screen.queryByText('login screen')).not.toBeInTheDocument();
  });

  it('redirects an anonymous visitor to /login', async () => {
    renderWithProviders(buildTree(), { route: '/admin', store: storeWith(null) });

    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('lets an authenticated admin through', async () => {
    renderWithProviders(buildTree(), { route: '/admin', store: storeWith(admin) });
    expect(await screen.findByText('admin dashboard')).toBeInTheDocument();
  });

  it('refuses a non-admin account with an explanatory panel', async () => {
    renderWithProviders(buildTree(), {
      route: '/admin',
      store: storeWith({ ...admin, role: 'customer' }),
    });

    expect(await screen.findByText(/administrator access required/i)).toBeInTheDocument();
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });

  it('forces the password rotation flow for a flagged account', async () => {
    renderWithProviders(buildTree(), {
      route: '/admin',
      store: storeWith({ ...admin, mustChangePassword: true }),
    });

    expect(await screen.findByText('change password screen')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/change-password');
  });

  it('still allows a flagged account to reach the change-password route itself', async () => {
    renderWithProviders(buildTree({ requireAdmin: false, allowFlaggedPassword: true }), {
      route: '/change-password-guarded',
      store: storeWith({ ...admin, mustChangePassword: true }),
    });

    expect(await screen.findByText('guarded password screen')).toBeInTheDocument();
  });

  it('never renders protected content while unauthenticated', () => {
    renderWithProviders(buildTree(), { route: '/admin', store: storeWith(null) });
    expect(screen.queryByText('admin dashboard')).not.toBeInTheDocument();
  });
});
