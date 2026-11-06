import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import ProductFormPage from './ProductFormPage.jsx';
import { renderWithProviders, jsonResponse } from '../../test/utils.jsx';

const existingProduct = {
  id: 'p1',
  title: 'Aurora Desk Lamp',
  description: 'A warm LED lamp with a dimmable head.',
  price: 2499,
  stock: 7,
  stockStatus: 'low_stock',
  sku: 'AUR-1234',
  image: null,
  thumbnail: null,
  isActive: true,
  version: 2,
  brand: { id: 'brand-1', name: 'Aurora' },
  category: { id: 'cat-1', name: 'Lighting' },
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-06T10:00:00.000Z',
};

/**
 * Stub for the product form's endpoints. Records method, path and the parsed
 * multipart body so the tests can assert the exact wire contract.
 */
function createFormFetch({ product = existingProduct, updateError = null } = {}) {
  const calls = [];

  const fetchMock = async (input, init = {}) => {
    const request = typeof input === 'string' ? null : input;
    const url = request ? request.url : input;
    const method = (request ? request.method : init.method) ?? 'GET';
    const { pathname } = new URL(url);

    let body = null;
    if (request && method !== 'GET' && method !== 'DELETE') {
      try {
        body = Object.fromEntries(await request.clone().formData());
      } catch {
        body = null;
      }
    }
    calls.push({ url, pathname, method, body });

    if (pathname.endsWith('/brands')) {
      return jsonResponse({ data: [{ id: 'brand-1', name: 'Aurora', slug: 'aurora' }] });
    }
    if (pathname.endsWith('/categories')) {
      return jsonResponse({ data: [{ id: 'cat-1', name: 'Lighting', slug: 'lighting' }] });
    }
    if (pathname.match(/\/admin\/products\/[^/]+$/) && method === 'GET') {
      return jsonResponse({ data: product });
    }
    if (pathname.endsWith('/admin/products') && method === 'POST') {
      return jsonResponse({ data: { ...existingProduct, id: 'p9' } }, { status: 201 });
    }
    if (pathname.match(/\/admin\/products\/[^/]+$/) && (method === 'PUT' || method === 'PATCH')) {
      if (updateError) return jsonResponse(updateError.body, { status: updateError.status });
      return jsonResponse({ data: { ...existingProduct, price: 2599, version: 3 } });
    }

    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };

  return { fetchMock, calls };
}

function renderForm(stub, { route = '/admin/products/p1' } = {}) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  const router = createMemoryRouter(
    [
      { path: '/admin/products', element: <p>product list screen</p> },
      { path: '/admin/products/new', element: <ProductFormPage /> },
      { path: '/admin/products/:id', element: <ProductFormPage /> },
    ],
    { initialEntries: [route] },
  );

  const view = renderWithProviders(null, { router });
  return { ...view, router };
}

function writeCalls(calls) {
  return calls.filter((call) => call.method !== 'GET');
}

describe('<ProductFormPage /> in edit mode', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('prefills the form from the server', async () => {
    renderForm(createFormFetch());

    expect(await screen.findByDisplayValue('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A warm LED lamp with a dimmable head.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2499')).toBeInTheDocument();
    expect(screen.getByDisplayValue('7')).toBeInTheDocument();
    expect(screen.getByDisplayValue('AUR-1234')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /brand/i })).toHaveValue('brand-1');
    expect(screen.getByRole('combobox', { name: /category/i })).toHaveValue('cat-1');
    expect(screen.getByText(/editing version 2/i)).toBeInTheDocument();
  });

  it('reports the form as clean until something changes', async () => {
    renderForm(createFormFetch());
    const user = userEvent.setup();

    expect(await screen.findByText('All changes saved')).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue('2499'));
    await user.type(screen.getByRole('spinbutton', { name: /price/i }), '2599');

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('blocks submission with client-side validation errors', async () => {
    const stub = createFormFetch();
    renderForm(stub);
    const user = userEvent.setup();

    const titleInput = await screen.findByDisplayValue('Aurora Desk Lamp');
    await user.clear(titleInput);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(screen.getByText(/fix the highlighted fields/i)).toBeInTheDocument();
    expect(writeCalls(stub.calls)).toHaveLength(0);
  });

  it('sends a multipart PUT carrying the optimistic-concurrency version', async () => {
    const stub = createFormFetch();
    renderForm(stub);
    const user = userEvent.setup();

    const price = await screen.findByDisplayValue('2499');
    await user.clear(price);
    await user.type(screen.getByRole('spinbutton', { name: /price/i }), '2599');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(writeCalls(stub.calls)).toHaveLength(1));
    const [request] = writeCalls(stub.calls);
    expect(request.method).toBe('PUT');
    expect(request.pathname).toBe('/api/v1/admin/products/p1');
    expect(request.body).toMatchObject({
      title: 'Aurora Desk Lamp',
      price: '2599',
      stock: '7',
      brand: 'brand-1',
      category: 'cat-1',
      isActive: 'true',
      version: '2',
    });
  });

  it('navigates back to the product list after a successful save', async () => {
    const stub = createFormFetch();
    const { router } = renderForm(stub);
    const user = userEvent.setup();

    const price = await screen.findByDisplayValue('2499');
    await user.clear(price);
    await user.type(screen.getByRole('spinbutton', { name: /price/i }), '2599');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('product list screen')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/products');
  });

  it('surfaces a version conflict with a reload action instead of overwriting', async () => {
    const stub = createFormFetch({
      updateError: {
        status: 409,
        body: {
          error: {
            code: 'STALE_RESOURCE',
            message: 'This product was modified by someone else. Reload and try again.',
          },
        },
      },
    });
    renderForm(stub);
    const user = userEvent.setup();

    const price = await screen.findByDisplayValue('2499');
    await user.clear(price);
    await user.type(screen.getByRole('spinbutton', { name: /price/i }), '2599');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/modified by someone else/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload latest/i })).toBeInTheDocument();
  });
});

describe('<ProductFormPage /> in create mode', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('starts empty and posts a new product', async () => {
    const stub = createFormFetch();
    renderForm(stub, { route: '/admin/products/new' });
    const user = userEvent.setup();

    await screen.findByRole('combobox', { name: /brand/i });
    await user.type(screen.getByRole('textbox', { name: /title/i }), 'Nova Floor Lamp');
    await user.type(
      screen.getByRole('textbox', { name: /description/i }),
      'A tall arc lamp with a marble base.',
    );
    await user.type(screen.getByRole('spinbutton', { name: /price/i }), '8999');
    await user.type(screen.getByRole('spinbutton', { name: /stock/i }), '4');
    await user.selectOptions(screen.getByRole('combobox', { name: /brand/i }), 'brand-1');
    await user.selectOptions(screen.getByRole('combobox', { name: /category/i }), 'cat-1');

    await user.click(screen.getByRole('button', { name: /create product/i }));

    await waitFor(() => expect(writeCalls(stub.calls)).toHaveLength(1));
    const [request] = writeCalls(stub.calls);
    expect(request.method).toBe('POST');
    expect(request.pathname).toBe('/api/v1/admin/products');
    expect(request.body).toMatchObject({
      title: 'Nova Floor Lamp',
      price: '8999',
      stock: '4',
      brand: 'brand-1',
      category: 'cat-1',
      isActive: 'true',
    });
    // A create must never send an optimistic-concurrency version.
    expect(request.body.version).toBeUndefined();
  });

  it('creates a brand inline and selects it without losing the form input', async () => {
    const stub = createFormFetch();
    renderForm(stub, { route: '/admin/products/new' });
    const user = userEvent.setup();

    await screen.findByRole('combobox', { name: /brand/i });
    await user.type(screen.getByRole('textbox', { name: /title/i }), 'Nova Floor Lamp');

    await user.click(screen.getAllByRole('button', { name: '+ New' })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /name/i }), 'Nova');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(
        stub.calls.some((call) => call.method === 'POST' && call.pathname === '/api/v1/brands'),
      ).toBe(true);
    });
    // The title typed before opening the modal is still there.
    expect(screen.getByDisplayValue('Nova Floor Lamp')).toBeInTheDocument();
  });
});
