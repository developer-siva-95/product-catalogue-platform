import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router';
import BrandsPage from './BrandsPage.jsx';
import { renderWithProviders, jsonResponse } from '../../test/utils.jsx';

const brands = [
  { id: 'brand-1', name: 'Aurora', slug: 'aurora', productCount: 4, activeProductCount: 3 },
  { id: 'brand-2', name: 'Nimbus', slug: 'nimbus', productCount: 0, activeProductCount: 0 },
];

function createBrandFetch({ deleteError = null, delayMs = 0 } = {}) {
  const calls = [];
  const fetchMock = async (input, init = {}) => {
    const request = typeof input === 'string' ? null : input;
    const url = request ? request.url : input;
    const method = (request ? request.method : init.method) ?? 'GET';
    const { pathname, searchParams } = new URL(url);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let body = null;
    if (request && method !== 'GET') {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }
    calls.push({ pathname, method, body, params: Object.fromEntries(searchParams) });

    if (pathname === '/api/v1/brands' && method === 'GET') return jsonResponse({ data: brands });
    if (pathname === '/api/v1/brands' && method === 'POST') {
      return jsonResponse(
        { data: { id: 'brand-9', name: body.name, slug: 'new' } },
        { status: 201 },
      );
    }
    if (pathname.match(/\/brands\/[^/]+$/) && method === 'PUT') {
      return jsonResponse({ data: { id: 'brand-1', ...body, slug: 'aurora' } });
    }
    if (pathname.match(/\/brands\/[^/]+$/) && method === 'DELETE') {
      if (deleteError) return jsonResponse(deleteError.body, { status: deleteError.status });
      return jsonResponse({ data: { id: 'brand-2' } });
    }
    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };
  return { fetchMock, calls };
}

function renderBrands(stub) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  return renderWithProviders(
    <Routes>
      <Route path="/admin/brands" element={<BrandsPage />} />
    </Routes>,
    { route: '/admin/brands' },
  );
}

describe('<BrandsPage />', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('lists brands with their product counts', async () => {
    renderBrands(createBrandFetch());

    expect(await screen.findByText('Aurora')).toBeInTheDocument();
    expect(screen.getByText('Nimbus')).toBeInTheDocument();
    expect(screen.getByText(/4 product\(s\) · 3 active/)).toBeInTheDocument();
  });

  it('creates a brand from the modal', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();

    await screen.findByText('Aurora');
    await user.click(screen.getByRole('button', { name: /new brand/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Vertex');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.method === 'POST');
      expect(post?.body).toEqual({ name: 'Vertex', description: '' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('refuses to submit an empty name', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();

    await screen.findByText('Aurora');
    await user.click(screen.getByRole('button', { name: /new brand/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(stub.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('edits an existing brand', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();

    await screen.findByText('Aurora');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByRole('textbox', { name: /name/i });
    expect(nameInput).toHaveValue('Aurora');

    await user.clear(nameInput);
    await user.type(nameInput, 'Aurora Lighting');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.method === 'PUT');
      expect(put.pathname).toBe('/api/v1/brands/brand-1');
      expect(put.body).toMatchObject({ name: 'Aurora Lighting' });
    });
  });

  it('deletes a brand after confirmation', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();

    await screen.findByText('Nimbus');
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[1]);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/deletion is refused while any product references it/i),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /delete brand/i }));

    await waitFor(() => {
      const del = stub.calls.find((call) => call.method === 'DELETE');
      expect(del.pathname).toBe('/api/v1/brands/brand-2');
    });
  });

  it('keeps the brand when the server refuses the deletion (in use)', async () => {
    const stub = createBrandFetch({
      deleteError: {
        status: 409,
        body: {
          error: { code: 'BRAND_IN_USE', message: 'This brand is used by 4 products.' },
        },
      },
    });
    const { store } = renderBrands(stub);
    const user = userEvent.setup();

    await screen.findByText('Aurora');
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete brand/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const toasts = store.getState().ui.toasts;
    expect(toasts.at(-1)).toMatchObject({ type: 'error' });
    expect(toasts.at(-1).message).toMatch(/used by 4 products/i);
  });
});

/**
 * Refresh control + mutation synchronisation for brand management.
 *
 * The refresh button must go through the existing `getBrands` endpoint with the
 * page's own argument, keep the list on screen while it runs, refuse a second
 * concurrent request, and surface a failure without dropping the rows. Writes must
 * revalidate through tags only — no manual `refetch()` after a mutation.
 */
describe('<BrandsPage /> refresh and mutation sync', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  const listGets = (calls) =>
    calls.filter((call) => call.pathname === '/api/v1/brands' && call.method === 'GET');

  it('renders the refresh control in the section header beside “New brand”', async () => {
    renderBrands(createBrandFetch());
    await screen.findByText('Aurora');

    const refresh = screen.getByRole('button', { name: /^refresh$/i });
    const create = screen.getByRole('button', { name: /new brand/i });

    expect(refresh.closest('.page-heading')).not.toBeNull();
    // Both live in the header's action group (the button itself is wrapped by the
    // refresh control's own span, so compare the surrounding row).
    expect(refresh.closest('.row')).not.toBeNull();
    expect(refresh.closest('.row')).toBe(create.closest('.row'));
  });

  it('re-requests the brands endpoint with the page argument when clicked', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora');

    expect(listGets(stub.calls)).toHaveLength(1);
    const before = listGets(stub.calls).at(-1);

    await user.click(screen.getByRole('button', { name: /^refresh$/i }));

    await waitFor(() => expect(listGets(stub.calls)).toHaveLength(2));
    const after = listGets(stub.calls).at(-1);
    expect(after.pathname).toBe('/api/v1/brands');
    expect(after.params).toEqual(before.params);
    // The rows are still there — a refresh replaces data, it does not clear it.
    expect(screen.getByText('Aurora')).toBeInTheDocument();
    expect(screen.getByText('Nimbus')).toBeInTheDocument();
  });

  it('shows the spinner and refuses a second concurrent refresh', async () => {
    const stub = createBrandFetch({ delayMs: 25 });
    renderBrands(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora');

    const button = screen.getByRole('button', { name: /^refresh$/i });
    const before = listGets(stub.calls).length;

    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button.querySelector('.btn__spinner')).not.toBeNull();

    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(listGets(stub.calls)).toHaveLength(before + 1);
  });

  it('keeps the list and shows the error when a refresh fails', async () => {
    const stub = createBrandFetch();
    let failNext = false;
    const fetchMock = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (typeof input === 'string' ? init?.method : input.method) ?? 'GET';
      if (failNext && method === 'GET' && new URL(url).pathname === '/api/v1/brands') {
        failNext = false;
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Brands unavailable' } },
          { status: 500 },
        );
      }
      return stub.fetchMock(input, init);
    };
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    renderWithProviders(
      <Routes>
        <Route path="/admin/brands" element={<BrandsPage />} />
      </Routes>,
      { route: '/admin/brands' },
    );
    const user = userEvent.setup();
    await screen.findByText('Aurora');

    failNext = true;
    await user.click(screen.getByRole('button', { name: /^refresh$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/brands unavailable/i);
    expect(screen.getByText('Aurora')).toBeInTheDocument();
    expect(screen.queryByText(/no brands yet/i)).not.toBeInTheDocument();
  });

  it('re-reads the list after a create without a manual refetch', async () => {
    const stub = createBrandFetch();
    renderBrands(stub);
    const user = userEvent.setup();
    await screen.findByText('Aurora');

    const before = listGets(stub.calls).length;

    await user.click(screen.getByRole('button', { name: /new brand/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Vertex');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(stub.calls.some((call) => call.method === 'POST')).toBe(true));
    // Tag invalidation drives it: the page never calls refetch() after a write.
    await waitFor(() => expect(listGets(stub.calls).length).toBe(before + 1));
  });
});
