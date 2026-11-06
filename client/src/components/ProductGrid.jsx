import ProductCard from './ProductCard.jsx';
import { useVirtualGrid } from '../hooks/useVirtualGrid.js';
import { VIRTUALIZE_THRESHOLD } from '../utils/constants.js';

/** Skeleton grid matching the real card footprint (no layout shift). */
export function ProductGridSkeleton({ count = 8 }) {
  return (
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}

/**
 * Product list.
 *
 * Below `VIRTUALIZE_THRESHOLD` products every card is mounted: a small result set
 * (a filtered search, a short catalogue) keeps the browser's own find-in-page and
 * printing working over the whole list, and the DOM is cheap anyway.
 *
 * Above the threshold the list is windowed row-by-row (see `useVirtualGrid`): the
 * viewport reserves the full height, only the rows around the visible band are
 * mounted, and the grid is translated to the first rendered row. DOM node count is
 * then bounded by the viewport and the overscan, not by how far the shopper has
 * scrolled.
 *
 * `aria-posinset`/`aria-setsize` on each card keep the position semantics intact
 * while part of the list is unmounted.
 *
 * @param {{ products: Array<object> }} props
 */
export function ProductGrid({ products }) {
  const virtualize = products.length > VIRTUALIZE_THRESHOLD;
  const {
    viewportRef,
    window: gridWindow,
    handleFocusCapture,
    handleBlurCapture,
  } = useVirtualGrid({ itemCount: products.length, enabled: virtualize });

  const startIndex = virtualize ? gridWindow.startIndex : 0;
  const endIndex = virtualize ? gridWindow.endIndex : products.length - 1;
  const visible = virtualize ? products.slice(startIndex, endIndex + 1) : products;

  return (
    <div
      ref={viewportRef}
      className={virtualize ? 'product-grid-viewport' : undefined}
      style={virtualize ? { height: `${gridWindow.totalHeight}px` } : undefined}
      data-testid="product-grid"
      data-virtualized={virtualize ? 'true' : 'false'}
    >
      <div
        className={`product-grid${virtualize ? ' product-grid--virtual' : ''}`}
        style={
          virtualize
            ? { transform: `translate3d(0, ${gridWindow.startRow * gridWindow.stride}px, 0)` }
            : undefined
        }
        onFocusCapture={virtualize ? handleFocusCapture : undefined}
        onBlurCapture={virtualize ? handleBlurCapture : undefined}
      >
        {visible.map((product, index) => {
          const position = startIndex + index;
          return (
            <ProductCard
              key={product.id}
              product={product}
              index={virtualize ? position : undefined}
              total={virtualize ? products.length : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

export default ProductGrid;
