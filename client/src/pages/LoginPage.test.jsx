import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import LoginPage from './LoginPage.jsx';
import { renderWithProviders, jsonResponse } from '../test/utils.jsx';
import { selectCurrentUser, selectIsAuthenticated } from '../features/auth/authSlice.js';

const user = {
  id: 'u1',
  name: 'Ada Admin',
  email: 'admin@catalogue.com',
  role: 'admin',
  mustChangePassword: false,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function createLoginFetch({ loginResponse, status = 200, delayMs = 0 } = {}) {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const request = typeof input === 'string' ? null : input;
    const url = request ? request.url : input;
    const method = (request ? request.method : init.method) ?? 'GET';
    const { pathname } = new URL(url);
    let body = null;
    if (request && method === 'POST') body = await request.clone().json();
    calls.push({ url, pathname, method, body });

    if (pathname.endsWith('/auth/csrf')) return jsonResponse({ data: { csrfToken: 'csrf-1' } });
    if (pathname.endsWith('/auth/login')) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return jsonResponse(loginResponse ?? { data: { user } }, {
        status: loginResponse ? status : 200,
      });
    }
    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };
  return { fetchMock, calls };
}

function renderLogin(stub) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  document.cookie = 'csrf_token=csrf-1; path=/';
  return renderWithProviders(
    <>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin" element={<p>admin dashboard</p>} />
        <Route path="/change-password" element={<p>change password screen</p>} />
      </Routes>
    </>,
    { route: '/login' },
  );
}

describe('<LoginPage />', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'csrf_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('validates the form before calling the API', async () => {
    const stub = createLoginFetch();
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects a malformed email address', async () => {
    const stub = createLoginFetch();
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), 'not-an-email');
    await user_.type(screen.getByLabelText(/password/i), 'secret123');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });

  it('posts normalised credentials with the CSRF header', async () => {
    const stub = createLoginFetch();
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), '  Admin@Catalogue.com ');
    await user_.type(screen.getByLabelText(/password/i), 'Admin123!');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    const loginCall = await vi.waitFor(() => {
      const call = stub.calls.find((entry) => entry.pathname.endsWith('/auth/login'));
      expect(call).toBeTruthy();
      return call;
    });
    expect(loginCall.method).toBe('POST');
    expect(loginCall.body).toEqual({ email: 'admin@catalogue.com', password: 'Admin123!' });
  });

  it('stores the session and redirects to the dashboard', async () => {
    const stub = createLoginFetch();
    const { store } = renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), 'admin@catalogue.com');
    await user_.type(screen.getByLabelText(/password/i), 'Admin123!');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('admin dashboard')).toBeInTheDocument();
    expect(selectIsAuthenticated(store.getState())).toBe(true);
    expect(selectCurrentUser(store.getState()).email).toBe('admin@catalogue.com');
  });

  it('sends a flagged account to the password-rotation screen', async () => {
    const stub = createLoginFetch({
      loginResponse: { data: { user: { ...user, mustChangePassword: true } } },
    });
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), 'admin@catalogue.com');
    await user_.type(screen.getByLabelText(/password/i), 'Admin123!');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('change password screen')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/change-password');
  });

  it('shows the server error message for bad credentials', async () => {
    const stub = createLoginFetch({
      status: 401,
      loginResponse: {
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
      },
    });
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), 'admin@catalogue.com');
    await user_.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/email or password is incorrect/i);
  });

  it('locks the form while the request is in flight', async () => {
    const stub = createLoginFetch({ delayMs: 200 });
    renderLogin(stub);
    const user_ = userEvent.setup();

    await user_.type(screen.getByRole('textbox', { name: /email/i }), 'admin@catalogue.com');
    await user_.type(screen.getByLabelText(/password/i), 'Admin123!');
    await user_.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('button', { name: /signing in/i })).toBeDisabled();
  });
});
