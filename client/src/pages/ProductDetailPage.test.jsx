import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Route, Routes, useLocation } from 'react-router';
import ProductDetailPage from './ProductDetailPage.jsx';
import { renderWithProviders, jsonResponse } from '../test/utils.jsx';
import { createAppStore } from '../app/store.js';

const product = {
  id: 'p1',
  title: 'Aurora Desk Lamp',
  description: 'A warm LED lamp with a dimmable head and a weighted base.',
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderDetail({ response, route = '/product/p1' } = {}) {
  const fetchMock = vi.fn(async () => response ?? jsonResponse({ data: product }));
  vi.stubGlobal('fetch', fetchMock);

  const view = renderWithProviders(
    <>
      <LocationProbe />
      <Routes>
        <Route path="/product/:id" element={<ProductDetailPage />} />
        <Route path="/" element={<p>storefront</p>} />
      </Routes>
    </>,
    { route },
  );

  return { ...view, fetchMock };
}

describe('<ProductDetailPage />', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the product, its price, stock badge and description', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Aurora Desk Lamp' })).toBeInTheDocument();
    expect(screen.getByText('Aurora')).toBeInTheDocument();
    expect(screen.getByText('AUR-1234')).toBeInTheDocument();
    expect(screen.getByText(/₹2,499/)).toBeInTheDocument();
    expect(screen.getByText('Low stock · 7 left')).toBeInTheDocument();
    expect(screen.getByText(/dimmable head/)).toBeInTheDocument();
  });

  it('requests the product by id', async () => {
    const { fetchMock } = renderDetail();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    const request = fetchMock.mock.calls[0][0];
    expect(request.url).toBe('http://localhost:3000/api/v1/products/p1');
    expect(request.method).toBe('GET');
  });

  it('links the category breadcrumb to the filtered storefront', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    expect(screen.getByRole('link', { name: 'Lighting' })).toHaveAttribute(
      'href',
      '/?category=cat-1',
    );
  });

  it('returns to the previous view when the card carried no router state', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: product })),
    );
    renderWithProviders(
      <>
        <LocationProbe />
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
          <Route path="/" element={<p>storefront</p>} />
        </Routes>
      </>,
      { route: '/product/p1' },
    );
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    // Simulate the router state a product card passes when clicked from a search.
    const backButton = screen.getByRole('button', { name: /back to results/i });
    await user.click(backButton);

    expect(await screen.findByText('storefront')).toBeInTheDocument();
  });

  it('shows a friendly not-found state for a 404', async () => {
    renderDetail({
      response: jsonResponse(
        { error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' } },
        { status: 404 },
      ),
    });

    expect(await screen.findByText(/product not available/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the storefront/i })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('shows a retryable error state for a server failure', async () => {
    renderDetail({
      response: jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
    });

    expect(await screen.findByText(/could not load this product/i)).toBeInTheDocument();
  });

  it('offers no cart or checkout control anywhere on the page', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cart|basket|checkout|buy now/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /cart|checkout/i })).toBeNull();
    expect(screen.queryByTestId('cart-count')).toBeNull();
    // The catalogue keeps its browsing affordances.
    expect(screen.getByRole('button', { name: /keep browsing/i })).toBeInTheDocument();
  });

  it('shows the available quantity for an in-stock product', async () => {
    renderDetail({
      response: jsonResponse({ data: { ...product, stock: 42, stockStatus: 'in_stock' } }),
    });

    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });
    expect(screen.getByText('In stock · 42 available')).toBeInTheDocument();
  });

  it('shows an out-of-stock badge without inventing a quantity', async () => {
    renderDetail({
      response: jsonResponse({
        data: { ...product, stock: 0, stockStatus: 'out_of_stock' },
      }),
    });

    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });
    const badge = screen.getByText('Out of stock');
    expect(badge).toHaveAttribute('data-stock-status', 'out_of_stock');
    expect(screen.queryByText(/0 available/)).not.toBeInTheDocument();
  });

  it('degrades gracefully when the API sends no stock information', async () => {
    renderDetail({
      response: jsonResponse({
        data: { ...product, stock: undefined, stockStatus: undefined },
      }),
    });

    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });
    expect(screen.getByText('Stock unavailable')).toBeInTheDocument();
  });
});

/**
 * Freshness contract for the product detail route.
 *
 * The detail page must (a) offer a manual refresh next to its management actions,
 * (b) re-read the document on every entry (`refetchOnMountOrArgChange: true`, so a
 * cached copy is never treated as authoritative), (c) follow the `:id` route param
 * — a different id is a different product — and (d) never blank the page when a
 * refresh fails.
 */
describe('<ProductDetailPage /> refresh and mount freshness', () => {
  const otherProduct = {
    ...product,
    id: 'p2',
    title: 'Nimbus Office Chair',
    sku: 'NIM-1234',
    stock: 0,
    stockStatus: 'out_of_stock',
    brand: { id: 'brand-2', name: 'Nimbus' },
    category: { id: 'cat-2', name: 'Seating' },
  };

  function renderRoute({ store = createAppStore(), route = '/product/p1' } = {}) {
    return renderWithProviders(
      <Routes>
        <Route path="/product/:id" element={<ProductDetailPage />} />
        <Route path="/" element={<p>storefront</p>} />
      </Routes>,
      { route, store },
    );
  }

  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('puts the refresh control in the detail action bar', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeEnabled();
    expect(button.closest('.detail__actions')).not.toBeNull();
    // The existing management action is untouched.
    expect(screen.getByRole('button', { name: /keep browsing/i })).toBeInTheDocument();
  });

  it('re-reads the same product when the refresh control is clicked', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderDetail();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0].url).toBe('http://localhost:3000/api/v1/products/p1');
    expect(screen.getByRole('heading', { name: 'Aurora Desk Lamp' })).toBeInTheDocument();
  });

  it('refetches on re-entry instead of trusting the cached document', async () => {
    const store = createAppStore();
    const fetchMock = vi.fn(async () => jsonResponse({ data: product }));
    vi.stubGlobal('fetch', fetchMock);

    const first = renderRoute({ store });
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // The cache entry is still alive (keepUnusedDataFor), but the route is entered
    // again, so the server is asked again.
    renderRoute({ store });
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('fetches the product named by the route param when the id changes', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return jsonResponse({ data: url.endsWith('/p2') ? otherProduct : product });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(
      <>
        <Link to="/product/p2">Next product</Link>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </>,
      { route: '/product/p1' },
    );

    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    await user.click(screen.getByRole('link', { name: /next product/i }));

    expect(await screen.findByRole('heading', { name: 'Nimbus Office Chair' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.at(-1)[0].url).toBe('http://localhost:3000/api/v1/products/p2');
    // The page is the new document, not the old one with a new URL.
    expect(screen.queryByText('Aurora Desk Lamp')).not.toBeInTheDocument();
  });

  it('keeps the loaded product and reports the failure when a refresh fails', async () => {
    const user = userEvent.setup();
    let failNext = false;
    const fetchMock = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Product unavailable' } },
          { status: 500 },
        );
      }
      return jsonResponse({ data: product });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderRoute();
    await screen.findByRole('heading', { name: 'Aurora Desk Lamp' });

    failNext = true;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/product unavailable/i);
    // The last good document is still on screen — no empty state, no blank page.
    expect(screen.getByRole('heading', { name: 'Aurora Desk Lamp' })).toBeInTheDocument();
    expect(screen.getByText('Low stock · 7 left')).toBeInTheDocument();
    expect(screen.queryByText(/could not load this product/i)).not.toBeInTheDocument();
  });
});
