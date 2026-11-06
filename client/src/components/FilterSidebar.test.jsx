import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FilterSidebar from './FilterSidebar.jsx';

const brands = [
  { id: 'b1', name: 'Aurora', activeProductCount: 4 },
  { id: 'b2', name: 'Nimbus', activeProductCount: 2 },
];

const categories = [{ id: 'c1', name: 'Lighting', activeProductCount: 3 }];

function setup(overrides = {}) {
  const props = {
    brands,
    categories,
    brand: '',
    category: '',
    minPrice: '',
    maxPrice: '',
    activeCount: 0,
    onBrandToggle: vi.fn(),
    onCategoryToggle: vi.fn(),
    onPriceApply: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };

  const view = render(<FilterSidebar {...props} />);
  return { ...view, props };
}

describe('<FilterSidebar /> desktop sidebar', () => {
  it('renders both facet groups with their counts', () => {
    setup();

    expect(screen.getByRole('complementary', { name: /product filters/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Aurora/ })).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: /^Lighting/ })).toHaveTextContent('3');
  });

  it('does not render a facet search for a short list', () => {
    setup();

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('adds a search box once a facet list gets long, and filters locally', async () => {
    const manyBrands = Array.from({ length: 12 }, (_, index) => ({
      id: `b${index}`,
      name: `Brand ${index}`,
      activeProductCount: index,
    }));
    const user = userEvent.setup();
    setup({ brands: manyBrands });

    const search = screen.getByRole('searchbox', { name: /search brand options/i });
    await user.type(search, 'Brand 1');

    // "Brand 1", "Brand 10" and "Brand 11" match.
    expect(screen.getByRole('button', { name: /^Brand 1\b/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Brand 10\b/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Brand 2\b/ })).not.toBeInTheDocument();
    expect(screen.getByText(/of 12 shown/i)).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText(/no brand matches/i)).toBeInTheDocument();
  });

  it('keeps the selected option visible and pressed while searching', async () => {
    const manyBrands = Array.from({ length: 12 }, (_, index) => ({
      id: `b${index}`,
      name: `Brand ${index}`,
      activeProductCount: 1,
    }));
    const user = userEvent.setup();
    setup({ brands: manyBrands, brand: 'b3' });

    const selected = screen.getByRole('button', { name: /^Brand 3\b/ });
    expect(selected).toHaveAttribute('aria-pressed', 'true');

    await user.type(screen.getByRole('searchbox', { name: /search brand options/i }), 'Brand 3');
    expect(screen.getByRole('button', { name: /^Brand 3\b/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reports the toggled facet id', async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole('button', { name: /^Nimbus/ }));
    expect(props.onBrandToggle).toHaveBeenCalledWith('b2');
  });

  it('submits the price range as trimmed strings', async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(screen.getByLabelText(/minimum price/i), '100');
    await user.type(screen.getByLabelText(/maximum price/i), '900');
    await user.click(screen.getByRole('button', { name: /apply price/i }));

    expect(props.onPriceApply).toHaveBeenCalledWith({ minPrice: '100', maxPrice: '900' });
  });

  it('offers "clear all" only while a filter is active', async () => {
    const user = userEvent.setup();
    const { unmount } = setup();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    unmount();

    const active = setup({ activeCount: 2 });
    await user.click(screen.getByRole('button', { name: /clear all/i }));
    expect(active.props.onReset).toHaveBeenCalled();
  });

  it('shows a loading placeholder instead of empty facets', () => {
    setup({ brands: [], brandsLoading: true });

    expect(screen.queryByRole('button', { name: /^Aurora/ })).not.toBeInTheDocument();
    expect(screen.getByText('Brand')).toBeInTheDocument();
  });
});

describe('<FilterSidebar /> mobile drawer', () => {
  it('hides the panel until the toggle is used', () => {
    setup({ isMobile: true, mobileOpen: false });

    const toggle = screen.getByRole('button', { name: /filters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('complementary', { name: /product filters/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the active filter count on the toggle', () => {
    setup({ isMobile: true, mobileOpen: false, activeCount: 3 });

    expect(screen.getByRole('button', { name: /filters/i })).toHaveTextContent('3');
  });

  it('exposes the facets, backdrop and footer when open', async () => {
    const user = userEvent.setup();
    const props = setup({
      isMobile: true,
      mobileOpen: true,
      activeCount: 1,
      onMobileClose: vi.fn(),
    });

    const panel = screen.getByRole('complementary', { name: /product filters/i });
    expect(within(panel).getByRole('button', { name: /^Aurora/ })).toBeInTheDocument();
    expect(screen.getByTestId('filters-backdrop')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show results/i }));
    expect(props.props.onMobileClose).toHaveBeenCalled();
  });

  it('closes on the close button, the backdrop and Escape', async () => {
    const user = userEvent.setup();

    const first = setup({
      isMobile: true,
      mobileOpen: true,
      onMobileClose: vi.fn(),
    });
    await user.click(screen.getByRole('button', { name: /close filters/i }));
    expect(first.props.onMobileClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = setup({ isMobile: true, mobileOpen: true, onMobileClose: vi.fn() });
    await user.click(screen.getByTestId('filters-backdrop'));
    expect(second.props.onMobileClose).toHaveBeenCalledTimes(1);
    second.unmount();

    const third = setup({ isMobile: true, mobileOpen: true, onMobileClose: vi.fn() });
    await user.keyboard('{Escape}');
    expect(third.props.onMobileClose).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll while open and restores it afterwards', () => {
    const { rerender } = setup({ isMobile: true, mobileOpen: true });
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <FilterSidebar
        brands={brands}
        categories={categories}
        brand=""
        category=""
        minPrice=""
        maxPrice=""
        activeCount={0}
        onBrandToggle={vi.fn()}
        onCategoryToggle={vi.fn()}
        onPriceApply={vi.fn()}
        onReset={vi.fn()}
        isMobile
        mobileOpen={false}
      />,
    );

    expect(document.body.style.overflow).toBe('');
  });
});
