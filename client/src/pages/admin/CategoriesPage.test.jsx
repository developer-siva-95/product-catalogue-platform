import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import CategoriesPage from './CategoriesPage.jsx';
import { renderWithProviders, jsonResponse } from '../../test/utils.jsx';

/**
 * Category management: the page itself (list + create/edit/delete) plus the refresh
 * control and tag-driven synchronisation.
 *
 * The stub mirrors the real contract of the endpoints the slice already declares —
 * `GET/POST /api/v1/categories`, `PUT/DELETE /api/v1/categories/:id` — and records
 * every call so the assertions are about actual requests, not internal state.
 */

const categories = [
  { id: 'cat-1', name: 'Lighting', slug: 'lighting', productCount: 3, activeProductCount: 3 },
  { id: 'cat-2', name: 'Seating', slug: 'seating', productCount: 0, activeProductCount: 0 },
];

function createCategoryFetch({ deleteError = null, delayMs = 0 } = {}) {
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

    if (pathname === '/api/v1/categories' && method === 'GET') {
      return jsonResponse({ data: categories });
    }
    if (pathname === '/api/v1/categories' && method === 'POST') {
      return jsonResponse({ data: { id: 'cat-9', name: body.name, slug: 'new' } }, { status: 201 });
    }
    if (/\/categories\/[^/]+$/.test(pathname) && method === 'PUT') {
      return jsonResponse({ data: { id: 'cat-1', ...body, slug: 'lighting' } });
    }
    if (/\/categories\/[^/]+$/.test(pathname) && method === 'DELETE') {
      if (deleteError) return jsonResponse(deleteError.body, { status: deleteError.status });
      return jsonResponse({ data: { id: 'cat-2' } });
    }
    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };
  return { fetchMock, calls };
}

function renderCategories(stub) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  return renderWithProviders(
    <Routes>
      <Route path="/admin/categories" element={<CategoriesPage />} />
    </Routes>,
    { route: '/admin/categories' },
  );
}

const listGets = (calls) =>
  calls.filter((call) => call.pathname === '/api/v1/categories' && call.method === 'GET');

describe('<CategoriesPage />', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('lists categories with their product counts', async () => {
    renderCategories(createCategoryFetch());

    expect(await screen.findByText('Lighting')).toBeInTheDocument();
    expect(screen.getByText('Seating')).toBeInTheDocument();
    expect(screen.getByText(/3 product\(s\) · 3 active/)).toBeInTheDocument();
  });

  it('creates a category from the modal', async () => {
    const stub = createCategoryFetch();
    renderCategories(stub);
    const user = userEvent.setup();

    await screen.findByText('Lighting');
    await user.click(screen.getByRole('button', { name: /new category/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Desks');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const post = stub.calls.find((call) => call.method === 'POST');
      expect(post?.body).toEqual({ name: 'Desks', description: '' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('edits an existing category', async () => {
    const stub = createCategoryFetch();
    renderCategories(stub);
    const user = userEvent.setup();
    await screen.findByText('Lighting');

    const row = screen.getByText('Lighting').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: /name/i });
    await user.clear(name);
    await user.type(name, 'Lamps');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.method === 'PUT');
      expect(put?.pathname).toBe('/api/v1/categories/cat-1');
      expect(put?.body.name).toBe('Lamps');
    });
  });

  it('deletes a category after confirmation', async () => {
    const stub = createCategoryFetch();
    renderCategories(stub);
    const user = userEvent.setup();
    await screen.findByText('Seating');

    const row = screen.getByText('Seating').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete category/i }));

    await waitFor(() => {
      const del = stub.calls.find((call) => call.method === 'DELETE');
      expect(del?.pathname).toBe('/api/v1/categories/cat-2');
    });
  });

  it('keeps the category when the server refuses the deletion (in use)', async () => {
    const stub = createCategoryFetch({
      deleteError: {
        status: 409,
        body: { error: { code: 'CATEGORY_IN_USE', message: 'Category is used by 3 products' } },
      },
    });
    renderCategories(stub);
    const user = userEvent.setup();
    await screen.findByText('Seating');

    const row = screen.getByText('Seating').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete category/i }));

    await waitFor(() => expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true));
    // The row survives a refused deletion.
    expect(screen.getByText('Seating')).toBeInTheDocument();
  });
});

/**
 * Refresh control + mutation synchronisation.
 *
 * Same contract as the brands page: one hook (`getCategories`), one `refetch()` per
 * click, the existing argument, no duplicate request while one is in flight, the
 * loaded rows preserved on failure, and writes revalidated by tags alone.
 */
describe('<CategoriesPage /> refresh and mutation sync', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the refresh control in the section header beside “New category”', async () => {
    renderCategories(createCategoryFetch());
    await screen.findByText('Lighting');

    const refresh = screen.getByRole('button', { name: /^refresh$/i });
    const create = screen.getByRole('button', { name: /new category/i });

    expect(refresh.closest('.page-heading')).not.toBeNull();
    expect(refresh.closest('.row')).not.toBeNull();
    expect(refresh.closest('.row')).toBe(create.closest('.row'));
  });

  it('re-requests the categories endpoint with the page argument when clicked', async () => {
    const stub = createCategoryFetch();
    renderCategories(stub);
    const user = userEvent.setup();
    await screen.findByText('Lighting');

    expect(listGets(stub.calls)).toHaveLength(1);
    const before = listGets(stub.calls).at(-1);

    await user.click(screen.getByRole('button', { name: /^refresh$/i }));

    await waitFor(() => expect(listGets(stub.calls)).toHaveLength(2));
    const after = listGets(stub.calls).at(-1);
    expect(after.pathname).toBe('/api/v1/categories');
    expect(after.params).toEqual(before.params);
    expect(screen.getByText('Lighting')).toBeInTheDocument();
    expect(screen.getByText('Seating')).toBeInTheDocument();
  });

  it('shows the spinner and refuses a second concurrent refresh', async () => {
    const stub = createCategoryFetch();

    // Deterministic in-flight window (same approach as the storefront refresh test):
    // the refresh request is held open until the test releases it, so the duplicate
    // clicks are guaranteed to land while it is still running. A fixed 25 ms delay was
    // a race — on a loaded runner the refresh had already settled and re-enabled the
    // button, so the extra clicks started real refresh rounds (3 list reads, not 2).
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    let listReads = 0;
    const fetchMock = (input, init = {}) => {
      const request = typeof input === 'string' ? null : input;
      const url = request ? request.url : input;
      const method = (request ? request.method : init.method) ?? 'GET';
      const isListRead = method === 'GET' && new URL(url).pathname === '/api/v1/categories';
      // `stub.fetchMock` records the call synchronously; only its response waits.
      const response = stub.fetchMock(input, init);
      if (!isListRead) return response;
      listReads += 1;
      if (listReads <= 1) return response; // the mount read of the list
      return response.then(async (settled) => {
        await refreshGate;
        return settled;
      });
    };

    renderCategories({ fetchMock, calls: stub.calls });
    const user = userEvent.setup();
    await screen.findByText('Lighting');

    const button = screen.getByRole('button', { name: /^refresh$/i });
    const before = listGets(stub.calls).length;
    expect(before).toBe(1);

    try {
      await user.click(button);

      // Exactly one extra list read, and it is still pending.
      await waitFor(() => expect(listGets(stub.calls)).toHaveLength(before + 1));
      await waitFor(() => expect(button).toBeDisabled());
      expect(button.querySelector('.btn__spinner')).not.toBeNull();

      // Two clicks while the refresh is definitely still in flight: no extra reads.
      await user.click(button);
      await user.click(button);
      expect(listGets(stub.calls)).toHaveLength(before + 1);
    } finally {
      // Always release, even when an assertion above fails, so no request stays pending.
      releaseRefresh();
    }

    await waitFor(() => expect(button).toBeEnabled());
    // The queued clicks never turned into requests, even once the refresh settled.
    expect(listGets(stub.calls)).toHaveLength(before + 1);
  });

  it('keeps the rows and shows the error when a refresh fails', async () => {
    const stub = createCategoryFetch();
    let failNext = false;
    const fetchMock = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (typeof input === 'string' ? init?.method : input.method) ?? 'GET';
      if (failNext && method === 'GET' && new URL(url).pathname === '/api/v1/categories') {
        failNext = false;
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Categories unavailable' } },
          { status: 500 },
        );
      }
      return stub.fetchMock(input, init);
    };
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    renderWithProviders(
      <Routes>
        <Route path="/admin/categories" element={<CategoriesPage />} />
      </Routes>,
      { route: '/admin/categories' },
    );
    const user = userEvent.setup();
    await screen.findByText('Lighting');

    failNext = true;
    await user.click(screen.getByRole('button', { name: /^refresh$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/categories unavailable/i);
    expect(screen.getByText('Lighting')).toBeInTheDocument();
    expect(screen.queryByText(/no categories yet/i)).not.toBeInTheDocument();
  });

  it('re-reads the list after a create without a manual refetch', async () => {
    const stub = createCategoryFetch();
    renderCategories(stub);
    const user = userEvent.setup();
    await screen.findByText('Lighting');

    const before = listGets(stub.calls).length;

    await user.click(screen.getByRole('button', { name: /new category/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Desks');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(stub.calls.some((call) => call.method === 'POST')).toBe(true));
    await waitFor(() => expect(listGets(stub.calls).length).toBe(before + 1));
  });
});
