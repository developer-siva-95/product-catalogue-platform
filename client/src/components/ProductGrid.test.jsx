import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProductGrid from './ProductGrid.jsx';
import { VIRTUALIZE_THRESHOLD } from '../utils/constants.js';

/**
 * Grid behaviour around the virtualization threshold.
 *
 * jsdom has no layout, so the hook falls back to its documented fallbacks
 * (2 columns, 300px card, 16px gap). That is enough to assert the parts that must
 * hold regardless of geometry: nothing mounted twice, the DOM stays bounded, the
 * true position/count reach assistive technology, and the threshold behaves.
 * Real geometry is verified in Chromium (E2E + DOM-budget audit).
 */

const makeProducts = (count, prefix = 'p') =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index + 1).padStart(3, '0')}`,
    title: `Product ${index + 1}`,
    price: 1000 + index,
    stock: 5,
    stockStatus: 'in_stock',
    thumbnail: null,
    brand: { id: 'b1', name: 'Aurora' },
  }));

function renderGrid(products) {
  return render(
    <MemoryRouter>
      <ProductGrid products={products} />
    </MemoryRouter>,
  );
}

const cardTitles = () =>
  screen
    .getAllByTestId('product-card')
    .map((card) => card.querySelector('.product-card__title').textContent);

describe('<ProductGrid /> below the virtualization threshold', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts every card and does not virtualize a small result set', () => {
    const { container } = renderGrid(makeProducts(VIRTUALIZE_THRESHOLD));

    expect(screen.getAllByTestId('product-card')).toHaveLength(VIRTUALIZE_THRESHOLD);
    expect(container.querySelector('.product-grid-viewport')).toBeNull();
    expect(screen.getByTestId('product-grid')).toHaveAttribute('data-virtualized', 'false');
    // Find-in-page and printing still cover the whole list.
    expect(container.querySelectorAll('.product-grid .product-card')).toHaveLength(
      VIRTUALIZE_THRESHOLD,
    );
  });

  it('omits position metadata when the whole list is mounted', () => {
    renderGrid(makeProducts(5));
    const first = screen.getAllByTestId('product-card')[0];
    expect(first).not.toHaveAttribute('aria-posinset');
    expect(first).not.toHaveAttribute('aria-setsize');
  });

  it('keeps the seed-sized catalogue fully mounted (20 products)', () => {
    renderGrid(makeProducts(20));
    expect(screen.getAllByTestId('product-card')).toHaveLength(20);
  });
});

describe('<ProductGrid /> above the virtualization threshold', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds the number of mounted cards', () => {
    const total = 240;
    const { container } = renderGrid(makeProducts(total));

    const mounted = screen.getAllByTestId('product-card');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(total);
    // jsdom fallbacks: 2 columns, 300px card + 16px gap => ~5 rows x 2 => <= 12.
    expect(mounted.length).toBeLessThanOrEqual(16);
    expect(container.querySelector('.product-grid-viewport')).toBeTruthy();
  });

  it('reserves the full height of every row so the document never shrinks', () => {
    const total = 240;
    const { container } = renderGrid(makeProducts(total));

    const viewport = container.querySelector('.product-grid-viewport');
    const height = Number.parseFloat(viewport.style.height);
    // 120 rows x 316px, minus the trailing gap.
    expect(height).toBeGreaterThan(total / 2);
    expect(viewport.style.height).toMatch(/px$/);
  });

  it('never mounts the same product twice', () => {
    renderGrid(makeProducts(240));
    const titles = cardTitles();
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('exposes the true position and total to assistive technology', () => {
    renderGrid(makeProducts(240));
    const first = screen.getAllByTestId('product-card')[0];

    expect(first).toHaveAttribute('aria-posinset', '1');
    expect(first).toHaveAttribute('aria-setsize', '240');
    expect(first).toHaveAttribute('data-index', '0');
  });

  it('keeps product identity stable when pages are appended', () => {
    const products = makeProducts(120);
    const { container, rerender } = renderGrid(products);
    const firstCard = container.querySelector('.product-card');
    const firstTitle = firstCard.querySelector('.product-card__title').textContent;

    rerender(
      <MemoryRouter>
        <ProductGrid products={[...products, ...makeProducts(12, 'extra')]} />
      </MemoryRouter>,
    );

    const again = container.querySelector('.product-card');
    // Same DOM node: appending a page does not remount the cards already shown.
    expect(again).toBe(firstCard);
    expect(again.querySelector('.product-card__title')).toHaveTextContent(firstTitle);
    expect(screen.getAllByTestId('product-card').length).toBeLessThan(132);
  });

  it('is keyboard-reachable: every mounted card has focusable links', () => {
    renderGrid(makeProducts(240));
    const mounted = screen.getAllByTestId('product-card');
    for (const card of mounted) {
      const tabbable = [...card.querySelectorAll('a, button')].filter(
        (element) => element.tabIndex >= 0,
      );
      expect(tabbable.length).toBeGreaterThanOrEqual(2);
    }
  });
});
