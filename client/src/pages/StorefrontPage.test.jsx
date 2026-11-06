import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import StorefrontPage from './StorefrontPage.jsx';
import { renderWithProviders } from '../test/utils.jsx';
import { createStorefrontFetch } from '../test/storefrontFetch.js';
import { stubIntersectionObserver, stubMobileViewport } from '../test/intersectionObserver.js';

/** Exposes the router location so URL-sync assertions are possible in jsdom. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderStorefront({ route = '/', fetchStub } = {}) {
  const stub = fetchStub ?? createStorefrontFetch();
  vi.stubGlobal('fetch', vi.fn(stub.fetchMock));

  const view = renderWithProviders(
    <>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<StorefrontPage />} />
      </Routes>
    </>,
    { route },
  );

  return { ...view, calls: stub.calls };
}

function productRequests(calls) {
  return calls.filter((call) => call.pathname.endsWith('/products'));
}

describe('<StorefrontPage />', () => {
  let observer;

  beforeEach(() => {
    vi.unstubAllGlobals();
    observer = stubIntersectionObserver();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the first page of products with their brand names', async () => {
    renderStorefront();

    expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText('Nimbus Office Chair')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shop the catalogue' })).toBeInTheDocument();
  });

  it('loads the facets from the server', async () => {
    renderStorefront();

    expect(await screen.findByRole('button', { name: /^Aurora/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Nimbus/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Lighting/ })).toBeInTheDocument();
  });

  it('requests the first page with the page size and no cursor', async () => {
    const { calls } = renderStorefront();
    await screen.findByText('Aurora Desk Lamp');

    const [firstRequest] = productRequests(calls);
    expect(firstRequest.params.limit).toBe('12');
    expect(firstRequest.params.cursor).toBeUndefined();
    expect(firstRequest.params.sort).toBe('newest');
  });

  it('appends the next page when the sentinel scrolls into view', async () => {
    const { calls } = renderStorefront();
    await screen.findByText('Aurora Desk Lamp');

    // No "Load more" control: paging is driven by the observed sentinel.
    expect(screen.queryByRole('button', { name: /load more products/i })).not.toBeInTheDocument();

    await act(async () => {
      observer.emit(true);
    });

    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
    // Earlier products are still rendered (cached pages are merged).
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();

    const requests = productRequests(calls);
    expect(requests).toHaveLength(2);
    expect(requests[1].params.cursor).toBe('cursor-page-2');
  });

  it('never fires the same page twice when the sentinel reports repeatedly', async () => {
    // A slow page keeps the request in flight while the observer fires again.
    const stub = createStorefrontFetch({ delayMs: 40 });
    const { calls } = renderStorefront({ fetchStub: stub });
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
      observer.emit(true);
      observer.emit(true);
    });

    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();

    const secondPageRequests = productRequests(calls).filter(
      (call) => call.params.cursor === 'cursor-page-2',
    );
    expect(secondPageRequests).toHaveLength(1);
  });

  it('does not render a product twice when two pages overlap', async () => {
    const overlapping = createStorefrontFetch({
      pages: [
        {
          products: [
            {
              id: 'p1',
              title: 'Aurora Desk Lamp',
              price: 2499,
              brand: 'Aurora',
              category: 'Lighting',
            },
          ],
          nextCursor: 'cursor-page-2',
        },
        {
          // The same product arrives again (products can shift between requests).
          products: [
            {
              id: 'p1',
              title: 'Aurora Desk Lamp',
              price: 2499,
              brand: 'Aurora',
              category: 'Lighting',
            },
            {
              id: 'p3',
              title: 'Vertex Standing Desk',
              price: 32999,
              brand: 'Vertex',
              category: 'Desks',
            },
          ],
          nextCursor: null,
        },
      ],
    });
    renderStorefront({ fetchStub: overlapping });
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
    });

    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
    expect(screen.getAllByText('Aurora Desk Lamp')).toHaveLength(1);
    expect(screen.getAllByTestId('product-card')).toHaveLength(2);
  });

  it('keeps the already rendered cards mounted when a page is appended', async () => {
    renderStorefront();
    await screen.findByText('Aurora Desk Lamp');

    const firstCard = screen.getByText('Aurora Desk Lamp').closest('article');
    expect(firstCard).not.toBeNull();

    await act(async () => {
      observer.emit(true);
    });
    await screen.findByText('Vertex Standing Desk');

    // The same DOM node, so the earlier card was not re-created by the append.
    expect(screen.getByText('Aurora Desk Lamp').closest('article')).toBe(firstCard);
  });

  it('shows the end-of-list state and stops requesting pages', async () => {
    const { calls } = renderStorefront();
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
    });

    expect(await screen.findByText(/you have reached the end/i)).toBeInTheDocument();

    const before = productRequests(calls).length;
    await act(async () => {
      observer.emit(true);
      observer.emit(true);
    });

    expect(productRequests(calls)).toHaveLength(before);
  });

  it('keeps the loaded products and offers a retry when the next page fails', async () => {
    const failingPage = createStorefrontFetch({
      pages: [
        {
          products: [
            {
              id: 'p1',
              title: 'Aurora Desk Lamp',
              price: 2499,
              brand: 'Aurora',
              category: 'Lighting',
            },
          ],
          nextCursor: 'cursor-page-2',
        },
        {
          failOnce: true,
          products: [
            {
              id: 'p3',
              title: 'Vertex Standing Desk',
              price: 32999,
              brand: 'Vertex',
              category: 'Desks',
            },
          ],
          nextCursor: null,
        },
      ],
    });
    renderStorefront({ fetchStub: failingPage });
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
    });

    // The first page survives the failure, and a retry control appears.
    expect(await screen.findByText(/products unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    expect(screen.getByText(/loading stopped/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
    expect(screen.getAllByText('Aurora Desk Lamp')).toHaveLength(1);
    expect(screen.getByText(/you have reached the end/i)).toBeInTheDocument();
  });

  it('carries the active filters into every subsequent page request', async () => {
    const { calls } = renderStorefront({ route: '/?brand=brand-2&sort=price_asc' });
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
    });

    await screen.findByText('Vertex Standing Desk');

    const requests = productRequests(calls);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      expect(request.params.brand).toBe('brand-2');
      expect(request.params.sort).toBe('price_asc');
    }
    expect(requests.at(-1).params.cursor).toBe('cursor-page-2');
  });

  it('applies a brand facet, mirrors it to the URL and restarts pagination', async () => {
    const { calls } = renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await act(async () => {
      observer.emit(true);
    });
    await screen.findByText('Vertex Standing Desk');

    await user.click(screen.getByRole('button', { name: /^Nimbus/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('?brand=brand-2');
    });

    // The cursor was dropped: a new filter set restarts from the first page.
    await waitFor(() => {
      const filtered = productRequests(calls).filter((call) => call.params.brand === 'brand-2');
      expect(filtered.length).toBeGreaterThan(0);
    });
    const filteredRequests = productRequests(calls).filter(
      (call) => call.params.brand === 'brand-2',
    );
    for (const request of filteredRequests) expect(request.params.cursor).toBeUndefined();
  });

  it('marks the active facet as pressed', async () => {
    renderStorefront({ route: '/?brand=brand-1' });
    const user = userEvent.setup();

    const auroraFacet = await screen.findByRole('button', { name: /^Aurora/ });
    await waitFor(() => expect(auroraFacet).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: /^Nimbus/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(auroraFacet);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    });
  });

  it('honours filters present in the URL on first load', async () => {
    const { calls } = renderStorefront({ route: '/?brand=brand-2&sort=price_asc' });
    await screen.findByText('Aurora Desk Lamp');

    // Exactly one request, already carrying the URL's filters (no unfiltered
    // first fetch followed by a filtered one).
    const requests = productRequests(calls);
    expect(requests).toHaveLength(1);
    expect(requests[0].params.brand).toBe('brand-2');
    expect(requests[0].params.sort).toBe('price_asc');
  });

  it('restores the stored filters when the URL carries none (back from detail)', async () => {
    // First mount with a filter in the URL seeds the store...
    const stub = createStorefrontFetch();
    const view = renderStorefront({ route: '/?brand=brand-1', fetchStub: stub });
    await screen.findByText('Aurora Desk Lamp');
    view.unmount();

    // ...then a later mount on a bare "/" writes them back into the URL.
    vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
    const second = renderWithProviders(
      <>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<StorefrontPage />} />
        </Routes>
      </>,
      { route: '/', store: view.store },
    );

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('?brand=brand-1');
    });
    await waitFor(() => {
      expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-1');
    });
    second.unmount();
  });

  it('commits the debounced search term to the query and the URL', async () => {
    const { calls } = renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.type(screen.getByRole('searchbox', { name: /search products/i }), 'lamp');

    await waitFor(
      () => {
        expect(productRequests(calls).at(-1).params.search).toBe('lamp');
      },
      { timeout: 3000 },
    );
    expect(screen.getByTestId('location')).toHaveTextContent('?search=lamp');
  });

  it('does not query for a single-character search', async () => {
    const { calls } = renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.type(screen.getByRole('searchbox', { name: /search products/i }), 'l');
    // Wait out the debounce inside act() so the timer cannot fire after teardown.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(productRequests(calls)).toHaveLength(1);
  });

  it('shows an empty state and can clear every filter', async () => {
    const emptyPage = createStorefrontFetch({
      pages: [{ products: [], nextCursor: null }],
    });
    renderStorefront({ route: '/?search=nomatch&brand=brand-1', fetchStub: emptyPage });
    const user = userEvent.setup();

    expect(await screen.findByText(/no products match your filters/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    });
  });

  it('surfaces a loading failure with a retry control', async () => {
    const failing = async () => {
      throw new TypeError('Failed to fetch');
    };
    const stub = createStorefrontFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn((input) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.includes('/products')) return failing();
        return stub.fetchMock(input);
      }),
    );

    renderWithProviders(
      <>
        <LocationProbe />
        <Routes>
          <Route path="/" element={<StorefrontPage />} />
        </Routes>
      </>,
      { route: '/' },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach the server/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('falls back to an explicit control when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { calls } = renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    const loadMore = await screen.findByRole('button', { name: /load more products/i });
    await user.click(loadMore);

    expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
    expect(productRequests(calls)[1].params.cursor).toBe('cursor-page-2');
  });

  it('disconnects its observer when the page unmounts', async () => {
    const view = renderStorefront();
    await screen.findByText('Aurora Desk Lamp');

    expect(observer.live()).toHaveLength(1);

    view.unmount();

    expect(observer.live()).toHaveLength(0);
  });

  it('opens, closes and traps the filters in a drawer on mobile', async () => {
    stubMobileViewport(true);
    renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    // The sidebar is not in the tab order until the drawer is opened.
    expect(screen.queryByRole('button', { name: /^Aurora/ })).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /filters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('button', { name: /^Aurora/ })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    // Escape closes it and releases the scroll lock.
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Aurora/ })).not.toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.body.style.overflow).toBe('');
    expect(toggle).toHaveFocus();
  });

  it('keeps the filter selection when the drawer is closed and reopened', async () => {
    stubMobileViewport(true);
    const { calls } = renderStorefront();
    const user = userEvent.setup();
    await screen.findByText('Aurora Desk Lamp');

    await user.click(screen.getByRole('button', { name: /filters/i }));
    await user.click(await screen.findByRole('button', { name: /^Nimbus/ }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('?brand=brand-2');
    });

    await user.click(screen.getByRole('button', { name: /show results/i }));
    expect(screen.queryByRole('button', { name: /^Nimbus/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /filters/i }));
    expect(await screen.findByRole('button', { name: /^Nimbus/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(productRequests(calls).some((call) => call.params.brand === 'brand-2')).toBe(true);
  });

  /**
   * Pagination depth + scroll restoration.
   *
   * The shopper's position in the listing has two halves — how many pages are
   * loaded (server data, owned by the RTK Query cache) and where the viewport sits
   * (pure UI, restored from `sessionStorage`). Neither is in the URL: pagination is
   * internal, so these cases also assert that no `?page=` is generated, replayed or
   * preserved, and that re-entering the route costs exactly one revalidation of the
   * page the list is parked on (never a page-1 reset, never a page per page).
   */
  describe('pagination depth and scroll restoration', () => {
    const SCROLL_KEY = 'catalogue:scroll:/?';

    /** jsdom has no layout, so the scroll geometry the hook measures is stubbed. */
    function stubScrollEnvironment({ scrollHeight = 3000, innerHeight = 768 } = {}) {
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        value: scrollHeight,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
      const scrollTo = vi.fn();
      vi.stubGlobal('scrollTo', scrollTo);
      return scrollTo;
    }

    const flush = async (ms = 30) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    };

    beforeEach(() => {
      window.sessionStorage.clear();
    });

    it('strips a legacy ?page= from the URL and starts at the first page', async () => {
      const { calls } = renderStorefront({ route: '/?page=2' });

      expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
      // Only the first page is loaded: the parameter is not a paging instruction.
      expect(screen.queryByText('Vertex Standing Desk')).not.toBeInTheDocument();

      const requests = productRequests(calls);
      expect(requests).toHaveLength(1);
      expect(requests[0].params.cursor).toBeUndefined();
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
      });
      // Never re-added after the fact.
      expect(screen.getByTestId('location').textContent).not.toMatch(/page=/);
    });

    it('restores the accumulated list on re-entry and revalidates it once', async () => {
      const stub = createStorefrontFetch();
      const view = renderStorefront({ fetchStub: stub });
      await screen.findByText('Aurora Desk Lamp');

      act(() => observer.emit(true));
      await screen.findByText('Vertex Standing Desk');
      // Depth grows internally; the URL stays free of pagination.
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
      });
      const requestsBefore = productRequests(stub.calls).length;
      expect(requestsBefore).toBe(2);
      view.unmount();

      // Come back to a bare "/" (what a detail-page Back link does): the cache holds
      // the pages, so the depth is restored from memory, and the route is
      // revalidated with one request for the page the list is parked on — not a
      // page-1 replay.
      vi.stubGlobal('fetch', vi.fn(stub.fetchMock));
      const second = renderWithProviders(
        <>
          <LocationProbe />
          <Routes>
            <Route path="/" element={<StorefrontPage />} />
          </Routes>
        </>,
        { route: '/', store: view.store },
      );

      expect(await screen.findByText('Vertex Standing Desk')).toBeInTheDocument();
      expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
      await flush(60);
      // Exactly one revalidation, for the deepest page: no collapse to page 1, no
      // replay of every page, no cache clearing.
      expect(productRequests(stub.calls)).toHaveLength(requestsBefore + 1);
      expect(productRequests(stub.calls).at(-1).params.cursor).toBe('cursor-page-2');
      expect(productRequests(stub.calls).at(-1).params.cursor).not.toBeUndefined();
      expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
      second.unmount();
    });

    it('ignores a legacy ?page= that points past the catalogue instead of replaying it', async () => {
      const { calls } = renderStorefront({ route: '/?page=5' });

      expect(await screen.findByText('Aurora Desk Lamp')).toBeInTheDocument();
      await flush(60);
      // Nothing is replayed and nothing is fetched twice.
      expect(productRequests(calls)).toHaveLength(1);
      expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
    });

    it('keeps the URL canonical when the filters change after paging', async () => {
      const { calls } = renderStorefront();
      const user = userEvent.setup();
      await screen.findByText('Aurora Desk Lamp');

      act(() => observer.emit(true));
      await screen.findByText('Vertex Standing Desk');
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
      });

      await user.click(screen.getByRole('button', { name: /^Nimbus/ }));

      await waitFor(() => {
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/\?brand=brand-2$/);
      });
      const lastRequest = productRequests(calls).at(-1);
      expect(lastRequest.params.brand).toBe('brand-2');
      expect(lastRequest.params.cursor).toBeUndefined();
    });

    it('restores the saved scroll offset without replaying any page', async () => {
      const scrollTo = stubScrollEnvironment();
      window.sessionStorage.setItem(SCROLL_KEY, '900');
      const { calls } = renderStorefront();

      await screen.findByText('Aurora Desk Lamp');
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));
      // The offset alone never costs a request: depth is not restored from the URL.
      expect(productRequests(calls)).toHaveLength(1);
      expect(screen.getByTestId('location').textContent).toMatch(/^\/\??$/);
    });

    it('does not scroll when the saved offset belongs to a taller list', async () => {
      const scrollTo = stubScrollEnvironment({ scrollHeight: 400 });
      window.sessionStorage.setItem(SCROLL_KEY, '900');
      renderStorefront();

      await screen.findByText('Aurora Desk Lamp');
      await flush(60);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('keeps a stale page response out of the view when the filters change mid-flight', async () => {
      // Page one answers immediately; the second page is slow enough that the
      // shopper can change filters while it is still in flight.
      const stub = createStorefrontFetch();
      const slowFetch = vi.fn(async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (new URL(url).searchParams.get('cursor')) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return stub.fetchMock(input);
      });
      vi.stubGlobal('fetch', slowFetch);

      const view = renderWithProviders(
        <>
          <LocationProbe />
          <Routes>
            <Route path="/" element={<StorefrontPage />} />
          </Routes>
        </>,
        { route: '/' },
      );
      const user = userEvent.setup();
      await screen.findByText('Aurora Desk Lamp');

      act(() => observer.emit(true));
      await waitFor(() => {
        expect(productRequests(stub.calls).some((call) => call.params.cursor)).toBe(true);
      });

      await user.click(screen.getByRole('button', { name: /^Nimbus/ }));
      await waitFor(() => {
        expect(productRequests(stub.calls).at(-1).params.brand).toBe('brand-2');
      });

      // The superseded page-two response lands after the filter switch: it belongs
      // to the old cache entry and must never be rendered here.
      await flush(120);
      expect(screen.queryByText('Vertex Standing Desk')).not.toBeInTheDocument();
      view.unmount();
    });
  });
});
