import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import ChangePasswordPage, { validatePasswordChange } from './ChangePasswordPage.jsx';
import { renderWithProviders, jsonResponse } from '../test/utils.jsx';
import { createAppStore } from '../app/store.js';
import { selectMustChangePassword, sessionEstablished } from '../features/auth/authSlice.js';

const base = {
  currentPassword: 'Admin123!',
  newPassword: 'Sup3rSecret!',
  confirmPassword: 'Sup3rSecret!',
};

describe('validatePasswordChange', () => {
  it('accepts a compliant change', () => {
    expect(validatePasswordChange(base)).toEqual({});
  });

  it('requires the current password', () => {
    expect(validatePasswordChange({ ...base, currentPassword: '' }).currentPassword).toBe(
      'Enter your current password',
    );
  });

  it('enforces the minimum length', () => {
    expect(
      validatePasswordChange({ ...base, newPassword: 'Sh0rt!', confirmPassword: 'Sh0rt!' }),
    ).toMatchObject({ newPassword: expect.stringMatching(/at least 10/) });
  });

  it('enforces the maximum length', () => {
    const long = `Aa1!${'x'.repeat(200)}`;
    expect(
      validatePasswordChange({ ...base, newPassword: long, confirmPassword: long }).newPassword,
    ).toMatch(/at most/);
  });

  it.each([
    ['no uppercase', 'sup3rsecret!'],
    ['no lowercase', 'SUP3RSECRET!'],
    ['no digit', 'Supersecret!'],
    ['no symbol', 'Sup3rsecret'],
  ])('rejects a password with %s', (_label, candidate) => {
    const errors = validatePasswordChange({
      ...base,
      newPassword: candidate,
      confirmPassword: candidate,
    });
    expect(errors.newPassword).toMatch(
      /uppercase letter, a lowercase letter, a number and a symbol/,
    );
  });

  it('rejects reusing the current password', () => {
    const errors = validatePasswordChange({
      currentPassword: 'Sup3rSecret!',
      newPassword: 'Sup3rSecret!',
      confirmPassword: 'Sup3rSecret!',
    });
    expect(errors.newPassword).toBe('New password must be different from the current password');
  });

  it('requires the confirmation to match', () => {
    expect(
      validatePasswordChange({ ...base, confirmPassword: 'Different1!' }).confirmPassword,
    ).toBe('Passwords do not match');
  });

  it('reports independent errors together', () => {
    const errors = validatePasswordChange({
      currentPassword: '',
      newPassword: 'weak',
      confirmPassword: 'nope',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['confirmPassword', 'currentPassword', 'newPassword'].sort(),
    );
  });
});

describe('<ChangePasswordPage /> flow', () => {
  const flaggedAdmin = {
    id: 'u1',
    name: 'Catalogue Administrator',
    email: 'admin@catalogue.com',
    role: 'admin',
    mustChangePassword: true,
  };

  function renderPage({ status = 200, body } = {}) {
    const calls = [];
    const fetchMock = async (input, init = {}) => {
      const request = typeof input === 'string' ? null : input;
      const url = request ? request.url : input;
      const method = (request ? request.method : init.method) ?? 'GET';
      const { pathname } = new URL(url);
      let payload = null;
      if (request && method === 'POST') {
        try {
          payload = await request.clone().json();
        } catch {
          payload = null;
        }
      }
      calls.push({ pathname, method, payload });

      if (pathname.endsWith('/auth/change-password')) {
        return jsonResponse(
          body ?? { data: { user: { ...flaggedAdmin, mustChangePassword: false } } },
          { status },
        );
      }
      if (pathname.endsWith('/auth/me')) {
        return jsonResponse({ data: { user: { ...flaggedAdmin, mustChangePassword: false } } });
      }
      return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
    };

    vi.stubGlobal('fetch', vi.fn(fetchMock));

    const store = createAppStore();
    store.dispatch(sessionEstablished(flaggedAdmin));

    const view = renderWithProviders(
      <Routes>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/admin" element={<p>admin dashboard</p>} />
        <Route path="/login" element={<p>login screen</p>} />
      </Routes>,
      { route: '/change-password', store },
    );

    return { ...view, store, calls };
  }

  it('blocks submission until the fields are valid', async () => {
    const { calls } = renderPage();
    const user = userEvent.setup();
    document.cookie = 'csrf_token=csrf-1; path=/';

    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('Enter your current password')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('reports a mismatched confirmation', async () => {
    renderPage();
    const user = userEvent.setup();
    document.cookie = 'csrf_token=csrf-1; path=/';

    await user.type(screen.getByLabelText(/current password/i), 'Admin123!');
    await user.type(screen.getByLabelText(/^new password/i), 'N3wSecure!2026');
    await user.type(screen.getByLabelText(/confirm/i), 'N3wSecure!2027');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
  });

  it('posts the change, clears the forced-rotation flag and enters the dashboard', async () => {
    const { store, calls } = renderPage();
    const user = userEvent.setup();
    document.cookie = 'csrf_token=csrf-1; path=/';

    await user.type(screen.getByLabelText(/current password/i), 'Admin123!');
    await user.type(screen.getByLabelText(/^new password/i), 'N3wSecure!2026');
    await user.type(screen.getByLabelText(/confirm/i), 'N3wSecure!2026');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText('admin dashboard')).toBeInTheDocument();

    const post = calls.find((call) => call.pathname.endsWith('/auth/change-password'));
    expect(post.payload).toEqual({
      currentPassword: 'Admin123!',
      newPassword: 'N3wSecure!2026',
      confirmPassword: 'N3wSecure!2026',
    });

    // The guard reads this flag synchronously; leaving it set would bounce the
    // user straight back to this screen (regression seen in the browser test).
    expect(selectMustChangePassword(store.getState())).toBe(false);
    expect(store.getState().ui.toasts.at(-1)).toMatchObject({ type: 'success' });
  });

  it('shows the server error when the current password is wrong', async () => {
    renderPage({
      status: 400,
      body: {
        error: { code: 'CURRENT_PASSWORD_INVALID', message: 'Current password is incorrect.' },
      },
    });
    const user = userEvent.setup();
    document.cookie = 'csrf_token=csrf-1; path=/';

    await user.type(screen.getByLabelText(/current password/i), 'wrong-one');
    await user.type(screen.getByLabelText(/^new password/i), 'N3wSecure!2026');
    await user.type(screen.getByLabelText(/confirm/i), 'N3wSecure!2026');
    await user.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i);
  });
});
