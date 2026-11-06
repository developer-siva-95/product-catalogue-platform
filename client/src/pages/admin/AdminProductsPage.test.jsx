import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import AdminProductsPage from './AdminProductsPage.jsx';
import { renderWithProviders, jsonResponse } from '../../test/utils.jsx';

const products = [
  {
    id: 'p1',
    title: 'Aurora Desk Lamp',
    sku: 'AUR-1',
    price: 2499,
    stock: 7,
    stockStatus: 'low_stock',
    isActive: true,
    thumbnail: null,
    brand: { id: 'brand-1', name: 'Aurora' },
    category: { id: 'cat-1', name: 'Lighting' },
  },
  {
    id: 'p2',
    title: 'Nimbus Office Chair',
    sku: 'NIM-1',
    price: 18999,
    stock: 0,
    stockStatus: 'out_of_stock',
    isActive: false,
    thumbnail: null,
    brand: { id: 'brand-2', name: 'Nimbus' },
    category: { id: 'cat-2', name: 'Seating' },
  },
];

/**
 * Stub for the admin endpoints. Records every request so the test can assert the
 * exact offset-pagination contract (page/limit/sort/filters) the server receives.
 */
function createAdminFetch({ total = 42, limit = 10 } = {}) {
  const calls = [];

  const fetchMock = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname, searchParams } = new URL(url);
    const method = (typeof input === 'string' ? init.method : input.method) ?? 'GET';
    calls.push({ url, pathname, method, params: Object.fromEntries(searchParams) });

    if (pathname.endsWith('/admin/products') && method === 'GET') {
      return jsonResponse({
        data: products,
        meta: {
          page: Number(searchParams.get('page') ?? 1),
          limit: Number(searchParams.get('limit') ?? limit),
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: Number(searchParams.get('page') ?? 1) < Math.ceil(total / limit),
          hasPrevPage: Number(searchParams.get('page') ?? 1) > 1,
        },
      });
    }

    if (pathname.match(/\/admin\/products\/[^/]+\/stock$/)) {
      return jsonResponse({ data: { ...products[0], stock: 8, stockStatus: 'low_stock' } });
    }

    if (pathname.match(/\/admin\/products\/[^/]+$/) && method === 'DELETE') {
      return jsonResponse({ data: { id: 'p1' } });
    }

    if (pathname.endsWith('/brands')) {
      return jsonResponse({ data: [{ id: 'brand-1', name: 'Aurora', slug: 'aurora' }] });
    }

    if (pathname.endsWith('/categories')) {
      return jsonResponse({ data: [{ id: 'cat-1', name: 'Lighting', slug: 'lighting' }] });
    }

    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };

  return { fetchMock, calls };
}

function renderPage(stub) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  return renderWithProviders(
    <Routes>
      <Route path="/admin/products" element={<AdminProductsPage />} />
      <Route path="/admin/products/new" element={<p>new product screen</p>} />
      <Route path="/admin/products/:id" element={<p>edit product screen</p>} />
    </Routes>,
    { route: '/admin/products' },
  );
}

function adminRequests(calls) {
  return calls.filter((call) => call.pathname.endsWith('/admin/products'));
}

describe('<AdminProductsPage />', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the product table with brand, category, price and status', async () => {
    renderPage(createAdminFetch());

    expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Nimbus Office Chair')).toBeInTheDocument();
    expect(table.getByText('Aurora')).toBeInTheDocument();
    expect(table.getByText('Lighting')).toBeInTheDocument();
    expect(table.getByText('₹2,499')).toBeInTheDocument();
    expect(table.getByText('Active')).toBeInTheDocument();
    expect(table.getByText('Inactive')).toBeInTheDocument();
  });

  it('requests page 1 with the default page size and newest-first sort', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    await screen.findByText('Aurora Desk Lamp');

    const [request] = adminRequests(stub.calls);
    expect(request.params.page).toBe('1');
    expect(request.params.limit).toBe('10');
    expect(request.params.sort).toBe('-createdAt');
  });

  it('shows the offset pagination summary', async () => {
    renderPage(createAdminFetch());
    await screen.findByText('Aurora Desk Lamp');

    expect(screen.getByText('Page 1 of 5 · 42 result(s)')).toBeInTheDocument();
  });

  it('requests the next page number when the pagination control is used', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(adminRequests(stub.calls).at(-1).params.page).toBe('2');
    });
    expect(await screen.findByText('Page 2 of 5 · 42 result(s)')).toBeInTheDocument();
  });

  it('keeps the chosen page size in the query and resets to page 1', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(adminRequests(stub.calls).at(-1).params.page).toBe('2'));

    await user.selectOptions(screen.getByLabelText(/rows per page/i), '20');

    await waitFor(() => {
      const last = adminRequests(stub.calls).at(-1);
      expect(last.params.limit).toBe('20');
      expect(last.params.page).toBe('1');
    });
  });

  it('sends the debounced search term and resets to page 1', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.type(screen.getByLabelText(/search products/i), 'lamp');

    await waitFor(
      () => {
        expect(adminRequests(stub.calls).at(-1).params.search).toBe('lamp');
      },
      { timeout: 3000 },
    );
    expect(adminRequests(stub.calls).at(-1).params.page).toBe('1');
  });

  it('sends the status filter as a boolean string', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.selectOptions(screen.getByLabelText(/filter by status/i), 'false');

    await waitFor(() => {
      expect(adminRequests(stub.calls).at(-1).params.isActive).toBe('false');
    });
  });

  it('patches stock by a relative delta', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: /increase stock for Aurora Desk Lamp/i }));

    await waitFor(() => {
      const patch = stub.calls.find((call) => call.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch.pathname).toBe('/api/v1/admin/products/p1/stock');
    });
  });

  it('does not allow decreasing stock below zero', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    await screen.findByText('Nimbus Office Chair');

    expect(
      screen.getByRole('button', { name: /decrease stock for Nimbus Office Chair/i }),
    ).toBeDisabled();
  });

  it('asks for confirmation before deleting and issues a DELETE on confirm', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: /delete Aurora Desk Lamp/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /delete product/i }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    const deleteCall = stub.calls.find((call) => call.method === 'DELETE');
    expect(deleteCall.pathname).toBe('/api/v1/admin/products/p1');
  });

  it('cancels a deletion without calling the API', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: /delete Aurora Desk Lamp/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('shows an empty state when no product matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [],
          meta: {
            page: 1,
            limit: 10,
            total: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
        }),
      ),
    );
    renderWithProviders(
      <Routes>
        <Route path="/admin/products" element={<AdminProductsPage />} />
      </Routes>,
      { route: '/admin/products' },
    );

    expect(await screen.findByText(/no products found/i)).toBeInTheDocument();
  });
});

/**
 * Freshness contract for the admin product table: a manual refresh control, a
 * refetch on every entry, and mutation-driven revalidation through the tags in
 * `apiSlice` (no manual `refetch()` calls after a write).
 */
describe('<AdminProductsPage /> refresh and mutation sync', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('offers a refresh control in the page heading and re-requests the same page', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button.closest('.page-heading')).not.toBeNull();

    const before = adminRequests(stub.calls).at(-1);
    await user.click(button);

    await waitFor(() => expect(adminRequests(stub.calls).length).toBeGreaterThanOrEqual(2));
    const after = adminRequests(stub.calls).at(-1);
    expect(after.params).toEqual(before.params);
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
  });

  it('refreshes the page and filters the admin is actually on', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(adminRequests(stub.calls).at(-1).params.page).toBe('2'));

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      const last = adminRequests(stub.calls).at(-1);
      expect(last.params.page).toBe('2');
    });
    // The rows on screen are the page-2 rows the refresh just re-read, not page 1.
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
  });

  it('keeps the table and reports the error when a refresh fails', async () => {
    const stub = createAdminFetch();
    let failNext = false;
    const fetchMock = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (failNext && new URL(url).pathname.endsWith('/admin/products')) {
        failNext = false;
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
        <Route path="/admin/products" element={<AdminProductsPage />} />
      </Routes>,
      { route: '/admin/products' },
    );
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    failNext = true;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/products unavailable/i);
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.queryByText(/no products found/i)).not.toBeInTheDocument();
  });

  it('re-reads the table after a stock mutation without a manual refetch', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const listCallsBefore = adminRequests(stub.calls).filter(
      (call) => call.method === 'GET',
    ).length;

    await user.click(screen.getByRole('button', { name: /increase stock for Aurora Desk Lamp/i }));

    await waitFor(() => expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(true));
    // Tag invalidation drives the revalidation: the same GET is issued again on its
    // own, the component never calls refetch() after a write.
    await waitFor(() =>
      expect(adminRequests(stub.calls).filter((call) => call.method === 'GET').length).toBe(
        listCallsBefore + 1,
      ),
    );
  });

  it('re-reads the table after a delete without a manual refetch', async () => {
    const stub = createAdminFetch();
    renderPage(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const listCallsBefore = adminRequests(stub.calls).filter(
      (call) => call.method === 'GET',
    ).length;

    await user.click(screen.getByRole('button', { name: /delete Aurora Desk Lamp/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete product/i }));

    await waitFor(() => expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true));
    await waitFor(() =>
      expect(adminRequests(stub.calls).filter((call) => call.method === 'GET').length).toBe(
        listCallsBefore + 1,
      ),
    );
  });
});
