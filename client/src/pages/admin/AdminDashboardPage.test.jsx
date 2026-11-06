import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import AdminDashboardPage from './AdminDashboardPage.jsx';
import { renderWithProviders, jsonResponse } from '../../test/utils.jsx';

/**
 * The dashboard reads four separate product cache entries (totals for all/active/
 * inactive plus the five most recent) and the two taxonomy lists. One refresh
 * control has to drive exactly one extra round of those requests — no more, and it
 * must not blank the figures when a round fails.
 */

const recentProduct = {
  id: 'p1',
  title: 'Aurora Desk Lamp',
  sku: 'AUR-1',
  price: 2499,
  stock: 7,
  stockStatus: 'low_stock',
  thumbnail: null,
  createdAt: '2026-01-05T10:00:00.000Z',
};

function createDashboardFetch({ totals = { all: 12, active: 9, inactive: 3 } } = {}) {
  const calls = [];

  const fetchMock = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname, searchParams } = new URL(url);
    const method = (typeof input === 'string' ? init.method : input.method) ?? 'GET';
    calls.push({ url, pathname, method, params: Object.fromEntries(searchParams) });

    if (pathname.endsWith('/admin/products')) {
      const isActive = searchParams.get('isActive');
      const total = isActive === 'true' ? totals.active : isActive === 'false' ? totals.inactive : totals.all;
      return jsonResponse({
        data: searchParams.get('limit') === '5' ? [recentProduct] : [],
        meta: { page: 1, limit: Number(searchParams.get('limit') ?? 10), total, totalPages: 1 },
      });
    }

    if (pathname.endsWith('/brands')) {
      return jsonResponse({ data: [{ id: 'brand-1', name: 'Aurora' }], meta: { total: 4 } });
    }

    if (pathname.endsWith('/categories')) {
      return jsonResponse({ data: [{ id: 'cat-1', name: 'Lighting' }], meta: { total: 2 } });
    }

    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };

  return { fetchMock, calls };
}

function dashboardRequests(calls) {
  return calls.filter((call) => call.method === 'GET');
}

function renderDashboard(stub) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  return renderWithProviders(
    <Routes>
      <Route path="/admin" element={<AdminDashboardPage />} />
    </Routes>,
    { route: '/admin' },
  );
}

describe('<AdminDashboardPage /> refresh', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the figures and the recent products table', async () => {
    const stub = createDashboardFetch();
    renderDashboard(stub);

    expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /recently added/i })).toBeInTheDocument();
  });

  it('places the refresh control above the inventory table', async () => {
    const stub = createDashboardFetch();
    renderDashboard(stub);
    await screen.findByText('Aurora Desk Lamp');

    const button = screen.getByRole('button', { name: /refresh/i });
    const card = button.closest('.card');
    expect(card).not.toBeNull();
    // Same card as the table, and before it in document order.
    const table = screen.getByRole('table');
    expect(card.contains(table)).toBe(true);
    expect(
      button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('re-reads every dashboard query when clicked', async () => {
    const stub = createDashboardFetch();
    renderDashboard(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const before = dashboardRequests(stub.calls).length;
    // Six hooks: four product queries + brands + categories.
    expect(before).toBe(6);

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(dashboardRequests(stub.calls).length).toBe(before + 6));
    // Same arguments as the initial round — a refresh re-reads, it does not re-scope.
    const initialPaths = dashboardRequests(stub.calls)
      .slice(0, 6)
      .map((call) => call.url)
      .sort();
    const refreshedPaths = dashboardRequests(stub.calls)
      .slice(6, 12)
      .map((call) => call.url)
      .sort();
    expect(refreshedPaths).toEqual(initialPaths);
    // The figures and rows stay on screen throughout.
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('does not stack a second round when clicked again while refreshing', async () => {
    const stub = createDashboardFetch();
    const slowStub = {
      calls: stub.calls,
      fetchMock: async (input, init) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return stub.fetchMock(input, init);
      },
    };
    renderDashboard(slowStub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const button = screen.getByRole('button', { name: /refresh/i });
    const before = dashboardRequests(stub.calls).length;

    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(dashboardRequests(stub.calls).length).toBe(before + 6);
  });

  it('keeps the figures and reports the failure when a refresh fails', async () => {
    const stub = createDashboardFetch();
    let failNextRound = false;
    const fetchMock = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (failNextRound && new URL(url).pathname.startsWith('/api/v1/admin/products')) {
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Products unavailable' } },
          { status: 500 },
        );
      }
      return stub.fetchMock(input, init);
    };
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    renderWithProviders(
      <Routes>
        <Route path="/admin" element={<AdminDashboardPage />} />
      </Routes>,
      { route: '/admin' },
    );
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    failNextRound = true;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/products unavailable/i);
    // Last good figures survive the failed round.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
  });
});
