import { useEffect, useRef } from 'react';
import { formatPrice } from '../utils/format.js';
import FilterFacet from './FilterFacet.jsx';

/**
 * Storefront facet panel.
 *
 * Facets are driven by server data (brands/categories with active product counts),
 * and each option is a toggle button rendered with `aria-pressed` so the selected
 * state is exposed to assistive tech.
 *
 * Responsive behaviour: from `--bp-lg` up the panel is a sticky sidebar; below it
 * the same markup becomes a modal drawer opened from a "Filters" button. The drawer
 * is only mounted while open, so its controls cannot be tabbed into while it is
 * closed, and while open it locks body scroll, closes on Escape/backdrop and
 * returns focus to the toggle.
 *
 * @param {{
 *   brands: Array<object>,
 *   categories: Array<object>,
 *   brandsLoading?: boolean,
 *   categoriesLoading?: boolean,
 *   brand: string,
 *   category: string,
 *   minPrice: string|number,
 *   maxPrice: string|number,
 *   activeCount: number,
 *   onBrandToggle: (id: string) => void,
 *   onCategoryToggle: (id: string) => void,
 *   onPriceApply: (range: { minPrice: string, maxPrice: string }) => void,
 *   onReset: () => void,
 *   isMobile?: boolean,
 *   mobileOpen?: boolean,
 *   onMobileOpen?: () => void,
 *   onMobileClose?: () => void,
 * }} props
 */
export function FilterSidebar({
  brands,
  categories,
  brandsLoading = false,
  categoriesLoading = false,
  brand,
  category,
  minPrice,
  maxPrice,
  activeCount,
  onBrandToggle,
  onCategoryToggle,
  onPriceApply,
  onReset,
  isMobile = false,
  mobileOpen = false,
  onMobileOpen,
  onMobileClose,
}) {
  const toggleRef = useRef(null);
  const closeRef = useRef(null);
  const drawerVisible = !isMobile || mobileOpen;

  // Drawer side effects: scroll lock, Escape to close, focus into the panel and
  // back to the toggle on close.
  useEffect(() => {
    if (!isMobile || !mobileOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const toggleButton = toggleRef.current;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onMobileClose?.();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    closeRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (toggleButton?.isConnected) toggleButton.focus();
    };
  }, [isMobile, mobileOpen, onMobileClose]);

  const handlePriceSubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onPriceApply({
      minPrice: form.get('minPrice')?.toString().trim() ?? '',
      maxPrice: form.get('maxPrice')?.toString().trim() ?? '',
    });
  };

  return (
    <>
      {isMobile ? (
        <div className="filters-bar">
          <button
            type="button"
            ref={toggleRef}
            className="btn btn--secondary filters-toggle"
            aria-expanded={mobileOpen}
            aria-controls="storefront-filters"
            onClick={onMobileOpen}
          >
            <span aria-hidden="true">☰</span>
            <span>Filters</span>
            {activeCount > 0 ? (
              <span className="filters-toggle__count" aria-label={`${activeCount} filters applied`}>
                {activeCount}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}

      {isMobile && mobileOpen ? (
        <div
          className="drawer-backdrop"
          data-testid="filters-backdrop"
          aria-hidden="true"
          onClick={() => onMobileClose?.()}
        />
      ) : null}

      {drawerVisible ? (
        <aside
          id="storefront-filters"
          className={`filters card${isMobile ? ' filters--drawer' : ''}`}
          aria-label="Product filters"
        >
          <div className="filters__header">
            <h2 className="filters__title">Filters</h2>
            <div className="filters__header-actions">
              {activeCount > 0 ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
                  Clear all
                </button>
              ) : null}
              {isMobile ? (
                <button
                  type="button"
                  ref={closeRef}
                  className="btn btn--ghost btn--sm filters__close"
                  onClick={() => onMobileClose?.()}
                  aria-label="Close filters"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              ) : null}
            </div>
          </div>

          <FilterFacet
            id="brand"
            title="Brand"
            options={brands}
            selected={brand}
            onToggle={onBrandToggle}
            loading={brandsLoading}
            emptyLabel="No brands yet"
          />

          <FilterFacet
            id="category"
            title="Category"
            options={categories}
            selected={category}
            onToggle={onCategoryToggle}
            loading={categoriesLoading}
            emptyLabel="No categories yet"
          />

          <form className="filters__group" onSubmit={handlePriceSubmit}>
            <h3 id="facet-price">Price range</h3>
            <div className="input-group" style={{ marginBottom: 10 }}>
              <input
                type="number"
                name="minPrice"
                className="input"
                placeholder="Min"
                min={0}
                defaultValue={minPrice}
                aria-label="Minimum price"
                inputMode="numeric"
              />
              <input
                type="number"
                name="maxPrice"
                className="input"
                placeholder="Max"
                min={0}
                defaultValue={maxPrice}
                aria-label="Maximum price"
                inputMode="numeric"
              />
            </div>
            <button type="submit" className="btn btn--secondary btn--sm btn--block">
              Apply price
            </button>
            {minPrice !== '' || maxPrice !== '' ? (
              <p className="field__hint" style={{ marginTop: 8 }}>
                {formatPrice(minPrice || 0)} – {maxPrice === '' ? 'any' : formatPrice(maxPrice)}
              </p>
            ) : null}
          </form>

          {isMobile ? (
            <div className="filters__footer">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => onMobileClose?.()}
              >
                Show results
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}

export default FilterSidebar;
