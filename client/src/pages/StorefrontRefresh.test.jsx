import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import StorefrontPage from './StorefrontPage.jsx';
import { createAppStore } from '../app/store.js';
import { renderWithProviders, jsonResponse } from '../test/utils.jsx';
import { createStorefrontFetch } from '../test/storefrontFetch.js';
import { stubIntersectionObserver } from '../test/intersectionObserver.js';

/**
 * Freshness contract for the storefront listing.
 *
 * Two separate mechanisms are covered:
 *  1. the manual refresh control (one click = one forced request through the
 *     existing `getStorefrontProducts` endpoint);
 *  2. route-mount freshness (`refetchOnMountOrArgChange: true`), i.e. coming back
 *     to the list asks the server again even though the cache still holds a page.
 *
 * Neither may collapse the accumulated pages, clear the cache, or replace a loaded
 * list with an empty one when the refresh fails.
 */

function renderList({ route = '/', stub, store = createAppStore() } = {}) {
  const fetchStub = stub ?? createStorefrontFetch();
  vi.stubGlobal('fetch', vi.fn(fetchStub.fetchMock));

  const view = renderWithProviders(
    <Routes>
      <Route path="/" element={<StorefrontPage />} />
    </Routes>,
    { route, store },
  );

  return { ...view, store, calls: fetchStub.calls };
}

function productRequests(calls) {
  return calls.filter((call) => call.pathname.endsWith('/products'));
}

describe('<StorefrontPage /> manual refresh and mount freshness', () => {
  let observer;

  beforeEach(() => {
    vi.unstubAllGlobals();
    observer = stubIntersectionObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes a refresh control inside the listing toolbar', async () => {
    renderList();
    await screen.findByText('Aurora Desk Lamp');

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeEnabled();
    // Requirement: it lives alongside the search field and the sort control.
    expect(button.closest('.toolbar')).not.toBeNull();
    expect(screen.getByLabelText(/sort products/i).closest('.toolbar')).not.toBeNull();
  });

  it('issues a new request for the current filters when clicked', async () => {
    const user = userEvent.setup();
    const { calls } = renderList();
    await screen.findByText('Aurora Desk Lamp');

    const before = productRequests(calls).at(-1);

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(productRequests(calls).length).toBeGreaterThanOrEqual(2));
    const after = productRequests(calls).at(-1);
    // Same listing, asked again: identical query string, no cache argument invented.
    expect(after.params).toEqual(before.params);
    // The already-rendered products stay on screen during and after the refresh.
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
  });

  it('shows the in-progress state and refuses a duplicate refresh request', async () => {
    const user = userEvent.setup();
    const stub = createStorefrontFetch({ delayMs: 25 });
    const { calls } = renderList({ stub });
    await screen.findByText('Aurora Desk Lamp');

    const button = screen.getByRole('button', { name: /refresh/i });
    const before = productRequests(calls).length;

    await user.click(button);

    // In flight: spinner + disabled, and the list is still usable.
    await waitFor(() => expect(button).toBeDisabled());
    expect(button.querySelector('.btn__spinner')).not.toBeNull();

    // Two further clicks must not queue two more requests.
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(productRequests(calls)).toHaveLength(before + 1);
  });

  it('keeps the list and reports the failure when a refresh fails', async () => {
    const user = userEvent.setup();
    const stub = createStorefrontFetch();
    let failNextProductsRequest = false;

    const fetchMock = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const isProductList = new URL(url).pathname.endsWith('/products');
      if (isProductList && failNextProductsRequest) {
        failNextProductsRequest = false;
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
        <Route path="/" element={<StorefrontPage />} />
      </Routes>,
      { route: '/' },
    );

    await screen.findByText('Aurora Desk Lamp');
    failNextProductsRequest = true;

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    // The error is surfaced…
    expect(await screen.findByRole('alert')).toHaveTextContent(/products unavailable/i);
    // …and the data the shopper was looking at is still there, not blanked out.
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('Nimbus Office Chair')).toBeInTheDocument();
    expect(screen.queryByText(/no products match your filters/i)).not.toBeInTheDocument();
  });

  it('refetches on re-entry even though the cache still holds the page', async () => {
    const stub = createStorefrontFetch();
    const store = createAppStore();

    const first = renderList({ stub, store });
    await screen.findByText('Aurora Desk Lamp');
    const beforeLeaving = productRequests(stub.calls).length;

    first.unmount();

    // Same store (so the RTK Query cache entry is still valid), fresh mount — the
    // classic "left a product detail, came back to the list" path.
    renderList({ stub, store });
    await screen.findByText('Aurora Desk Lamp');

    await waitFor(() =>
      expect(productRequests(stub.calls).length).toBeGreaterThanOrEqual(beforeLeaving + 1),
    );
  });

  it('does not collapse the accumulated pages when refreshing a deep list', async () => {
    const user = userEvent.setup();
    const { calls } = renderList();
    await screen.findByText('Aurora Desk Lamp');

    // Scroll the sentinel into view → second page appended.
    observer.emit(true);
    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
    const afterPaging = productRequests(calls).length;
    expect(afterPaging).toBe(2);
    expect(productRequests(calls).at(-1).params.cursor).toBe('cursor-page-2');

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(productRequests(calls).length).toBe(afterPaging + 1));
    // The refresh re-reads the page the list is parked on…
    expect(productRequests(calls).at(-1).params.cursor).toBe('cursor-page-2');
    // …so every previously loaded product survives (no page-1 reset, no duplicates).
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('Nimbus Office Chair')).toBeInTheDocument();
    expect(screen.getByText('Vertex Standing Desk')).toBeInTheDocument();
  });

  it('keeps filters and sort in the request a refresh makes', async () => {
    const user = userEvent.setup();
    const { calls } = renderList({ route: '/?sort=price_asc&search=lamp' });
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(productRequests(calls).length).toBeGreaterThanOrEqual(2));
    const refresh = productRequests(calls).at(-1);
    expect(refresh.params.sort).toBe('price_asc');
    expect(refresh.params.search).toBe('lamp');
  });
});
