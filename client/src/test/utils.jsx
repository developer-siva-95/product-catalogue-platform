import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { RouterProvider } from 'react-router/dom';
import { MemoryRouter } from 'react-router';
import { createAppStore } from '../app/store.js';

/**
 * Renders a component inside the real store and an in-memory router, so tests
 * exercise the same providers the application uses (no mocked Redux).
 */
export function renderWithProviders(ui, { route = '/', store = createAppStore(), router } = {}) {
  const tree = router ? (
    <RouterProvider router={router} />
  ) : (
    <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
  );

  const result = render(<Provider store={store}>{tree}</Provider>);

  return { ...result, store };
}

/** Builds a JSON `Response` for stubbed `fetch` implementations. */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Sets a cookie on the jsdom document (used for the CSRF contract). */
export function setCookie(name, value) {
  document.cookie = `${name}=${value}; path=/`;
}

export function clearCookies() {
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}
