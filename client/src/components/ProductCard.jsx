import { memo } from 'react';
import { Link, useLocation } from 'react-router';
import { formatPrice, initialsOf } from '../utils/format.js';
import StockBadge from './StockBadge.jsx';

/**
 * Storefront product card.
 *
 * Images are lazy-loaded and `decoding="async"`; the thumbnail (300x300, generated
 * server-side) is used so a grid of 48 cards stays cheap. A failed image falls
 * back to a neutral placeholder instead of a broken-image icon.
 *
 * Stock is shown in the card body (not over the image) so it never collides with
 * the badge overlay on a two-column phone layout, and it always comes from the
 * API's own `stock`/`stockStatus` fields.
 *
 * Memoised: infinite scrolling re-renders the storefront on every page append, and
 * the earlier pages keep their object identity through `merge`, so their cards skip
 * rendering entirely.
 *
 * When the grid is virtualized only part of the list is mounted, so the card also
 * carries its true 1-based position and the total count; assistive technology then
 * still announces "7 of 240" instead of "7 of 28".
 *
 * @param {{ product: object, index?: number, total?: number }} props
 */
export const ProductCard = memo(function ProductCard({ product, index, total }) {
  const location = useLocation();
  const href = `/product/${product.id}`;
  // Carries the storefront query string so "back" restores the filtered view.
  const linkState = { fromSearch: location.search };
  const soldOut = product.stockStatus === 'out_of_stock';

  return (
    <article
      className="product-card"
      data-testid="product-card"
      data-index={index}
      aria-posinset={typeof index === 'number' ? index + 1 : undefined}
      aria-setsize={typeof total === 'number' ? total : undefined}
    >
      <div className="product-card__media">
        <Link to={href} state={linkState} aria-label={`View ${product.title}`} tabIndex={-1}>
          {product.thumbnail ? (
            <img
              src={product.thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              width={300}
              height={300}
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <span className="product-card__placeholder" aria-hidden="true">
              {initialsOf(product.title)}
            </span>
          )}
        </Link>
        {soldOut ? (
          <div className="product-card__badges">
            <StockBadge stockStatus={product.stockStatus} stock={product.stock} />
          </div>
        ) : null}
      </div>

      <div className="product-card__body">
        {product.brand ? (
          <span className="product-card__brand">{product.brand.name}</span>
        ) : (
          <span className="product-card__brand">Unbranded</span>
        )}
        <h3 className="product-card__title">
          <Link to={href} state={linkState}>
            {product.title}
          </Link>
        </h3>

        {/* In/lower stock sits here; "Out of stock" is also badged over the image
            because it changes whether the product is worth opening at all. */}
        {soldOut ? null : (
          <StockBadge
            stockStatus={product.stockStatus}
            stock={product.stock}
            className="stock-badge--inline"
          />
        )}

        <div className="product-card__footer">
          <span className={`price${soldOut ? ' price--muted' : ''}`}>
            {formatPrice(product.price)}
          </span>
          <Link
            className="btn btn--secondary btn--sm"
            to={href}
            state={linkState}
            aria-label={`View details for ${product.title}`}
          >
            Details
          </Link>
        </div>
      </div>
    </article>
  );
});

export default ProductCard;
