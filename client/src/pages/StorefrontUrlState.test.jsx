import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, useLocation } from 'react-router';
import StorefrontPage from './StorefrontPage.jsx';
import ProductDetailPage from './ProductDetailPage.jsx';
import { createAppStore } from '../app/store.js';
import { renderWithProviders, jsonResponse } from '../test/utils.jsx';
import { createStorefrontFetch } from '../test/storefrontFetch.js';
import { stubIntersectionObserver } from '../test/intersectionObserver.js';

/**
 * The URL is the source of truth for customer search/filter/pagination state.
 *
 * These cases drive the real router (a memory router, so history semantics are the
 * ones a browser gives) and assert the *network* consequence of each URL: what the
 * `getStorefrontProducts` endpoint was actually asked for.
 *
 * Pagination is *not* part of that contract: `page` is internal state owned by the
 * RTK Query cache (one cursor per appended page), so a legacy `?page=` is stripped
 * from the URL and never influences the query arguments.
 */

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const listElement = (
  <>
    <LocationProbe />
    <StorefrontPage />
  </>
);

/** Adds the product-detail endpoint the storefront fetch stub does not cover. */
function withDetailEndpoint(stub) {
  const detail = (id) => ({
    id,
    title: 'Aurora Desk Lamp',
    description: 'A warm LED lamp with a dimmable head and a weighted base.',
    price: 2499,
    stock: 5,
    stockStatus: 'in_stock',
    sku: 'AUR-1',
    image: null,
    thumbnail: null,
    isActive: true,
    brand: { id: 'brand-1', name: 'Aurora' },
    category: { id: 'cat-1', name: 'Lighting' },
    createdAt: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-01-05T10:00:00.000Z',
  });

  const fetchMock = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname } = new URL(url);
    if (/\/products\/[^/]+$/.test(pathname)) {
      return jsonResponse({ data: detail(pathname.split('/').pop()) });
    }
    return stub.fetchMock(input, init);
  };

  return { fetchMock, calls: stub.calls };
}

function renderRouted({ routes, initialEntries, stub }) {
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
  const router = createMemoryRouter(routes, { initialEntries });
  const view = renderWithProviders(null, { router, store: createAppStore() });
  return { ...view, router, calls: stub.calls };
}

function productRequests(calls) {
  return calls.filter((call) => call.pathname.endsWith('/products'));
}

describe('<StorefrontPage /> URL-driven listing state', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // jsdom has no layout engine; the infinite-scroll sentinel needs a stub even for
    // tests that never scroll, because the hook subscribes on mount.
    stubIntersectionObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a fully filtered deep link with the URL parameters and nothing else', async () => {
    const stub = createStorefrontFetch();
    renderRouted({
      routes: [{ path: '/', element: listElement }],
      initialEntries: ['/?search=lamp&brand=brand-1&category=cat-1&sort=price_asc'],
      stub,
    });

    expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();

    // One request, already filtered: the first fetch is held back until the URL and
    // the store agree, so no unfiltered request is ever issued.
    const requests = productRequests(stub.calls);
    expect(requests).toHaveLength(1);
    expect(requests[0].params).toMatchObject({
      search: 'lamp',
      brand: 'brand-1',
      category: 'cat-1',
      sort: 'price_asc',
      limit: '12',
    });
    expect(requests[0].params.cursor).toBeUndefined();
  });

  it('strips a legacy pagination parameter while keeping the filter set', async () => {
    const stub = createStorefrontFetch();
    renderRouted({
      routes: [{ path: '/', element: listElement }],
      initialEntries: ['/?brand=brand-1&page=2'],
      stub,
    });

    expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
    // The parameter is not a paging instruction: only the first page is loaded…
    expect(screen.queryByText('Vertex Standing Desk')).not.toBeInTheDocument();

    const requests = productRequests(stub.calls);
    expect(requests).toHaveLength(1);
    expect(requests[0].params.brand).toBe('brand-1');
    expect(requests[0].params.cursor).toBeUndefined();

    // …and the URL keeps its filters but loses the pagination parameter.
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/?brand=brand-1');
    });
  });

  it('keeps the URL and the query argument in step when the sort changes', async () => {
    const user = userEvent.setup();
    const stub = createStorefrontFetch();
    renderRouted({
      routes: [{ path: '/', element: listElement }],
      initialEntries: ['/'],
      stub,
    });
    await screen.findByText('Aurora Desk Lamp');

    await user.selectOptions(screen.getByLabelText(/sort products/i), 'price_asc');

    await waitFor(() => {
      expect(productRequests(stub.calls).at(-1).params.sort).toBe('price_asc');
    });
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('?sort=price_asc');
    });
  });

  it('restores the URL-driven filters and refetches on browser back and forward', async () => {
    const stub = createStorefrontFetch();
    const { router } = renderRouted({
      routes: [{ path: '/', element: listElement }],
      initialEntries: ['/?brand=brand-1'],
      stub,
    });
    await screen.findByText('Aurora Desk Lamp');
    expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-1');

    // A link (or a shared URL) to a different filter set → new history entry.
    await act(async () => {
      await router.navigate('/?brand=brand-2');
    });
    await waitFor(() => {
      expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-2');
    });

    // Back: the store follows the URL again and the list is refetched for it.
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => {
      expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-1');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('brand=brand-1');

    // Forward: and back to the second filter set.
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => {
      expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-2');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('brand=brand-2');
  });

  it('refetches the filtered list when coming back from a product detail', async () => {
    const user = userEvent.setup();
    const stub = withDetailEndpoint(createStorefrontFetch());
    renderRouted({
      routes: [
        { path: '/', element: listElement },
        { path: '/product/:id', element: <ProductDetailPage /> },
      ],
      initialEntries: ['/?brand=brand-1&sort=price_asc'],
      stub,
    });

    await screen.findByText('Aurora Desk Lamp');
    const listRequestsBefore = productRequests(stub.calls).length;
    expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-1');

    await user.click(screen.getByRole('link', { name: 'Aurora Desk Lamp' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Aurora Desk Lamp' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to results/i }));

    // Back on the *filtered* URL, with a fresh request for exactly that filter set.
    await waitFor(() => {
      expect(productRequests(stub.calls).length).toBe(listRequestsBefore + 1);
    });
    const refresh = productRequests(stub.calls).at(-1);
    expect(refresh.params.brand).toBe('brand-1');
    expect(refresh.params.sort).toBe('price_asc');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('brand=brand-1');
    });
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
  });
});
