import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useGetProductQuery } from '../api/apiSlice.js';
import { errorMessage, formatDate, formatPrice } from '../utils/format.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import StockBadge from '../components/StockBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import { LoadingBlock } from '../components/Spinner.jsx';

/**
 * Public product detail.
 *
 * "Back to results" returns to the storefront *with the previous filter set*
 * (filters live in Redux and are mirrored to the URL), so a shopper never loses
 * their search context when inspecting a product.
 */
export function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Always revalidated on entry, whatever the cache still holds: the id in the URL
  // is the query argument, so a route change to another product fetches that
  // product, and coming back to this one asks the server again instead of showing
  // retained data. The fresh copy is written back into the cached listings by the
  // endpoint itself.
  const { data, error, isLoading, isFetching, refetch } = useGetProductQuery(id, {
    refetchOnMountOrArgChange: true,
  });

  const product = data?.data;
  useDocumentTitle(product?.title ?? 'Product');

  const handleBack = () => {
    if (location.state?.fromSearch) {
      navigate(`/${location.state.fromSearch}`, { replace: false });
      return;
    }
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  if (isLoading) return <LoadingBlock label="Loading product…" />;

  /**
   * A failed *refresh* must never blank out a product the shopper is reading: the
   * full-page error is only for "we have nothing to show". When a document is on
   * screen, the failure is reported inline and the last good copy stays.
   */
  if (error && !product) {
    const notFound = error.status === 404;
    return (
      <div className="container page">
        <EmptyState
          icon={notFound ? '🔍' : '⚠'}
          title={notFound ? 'Product not available' : 'Could not load this product'}
          description={
            notFound
              ? 'This product may have been removed or is no longer available in the store.'
              : 'Something went wrong while loading the product. Please try again.'
          }
          action={
            <Link className="btn btn--primary" to="/">
              Back to the storefront
            </Link>
          }
        />
      </div>
    );
  }

  if (!product) return null;

  return (
    <div className="container page">
      {error ? (
        <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {errorMessage(error, 'Could not refresh this product — showing the last loaded copy.')}
          </span>
        </div>
      ) : null}

      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <button type="button" onClick={handleBack}>
          ← Back to results
        </button>
        <span aria-hidden="true">/</span>
        {product.category ? (
          <Link to={`/?category=${product.category.id}`}>{product.category.name}</Link>
        ) : null}
        <span aria-hidden="true">/</span>
        <span aria-current="page">{product.title}</span>
      </nav>

      <div className="detail">
        <div className="detail__media">
          {product.image ? (
            <img
              src={product.image}
              alt={product.title}
              width={1200}
              height={900}
              decoding="async"
              className="detail__image"
            />
          ) : (
            <div
              aria-label="No product image"
              style={{
                height: '100%',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--color-text-subtle)',
                fontSize: 42,
              }}
            >
              ⌾
            </div>
          )}
        </div>

        <div>
          {product.brand ? <span className="product-card__brand">{product.brand.name}</span> : null}
          <h1 className="detail__title">{product.title}</h1>

          <div className="detail__price-row">
            <span className="detail__price">{formatPrice(product.price)}</span>
            <StockBadge stockStatus={product.stockStatus} stock={product.stock} variant="detail" />
            {product.isActive ? null : <span className="badge badge--neutral">Inactive</span>}
          </div>

          <div className="detail__meta">
            <span>
              SKU: <span className="mono">{product.sku ?? '—'}</span>
            </span>
            <span>Added {formatDate(product.createdAt)}</span>
            {product.category ? <span>Category: {product.category.name}</span> : null}
          </div>

          <p className="detail__description">{product.description}</p>

          <div className="detail__actions">
            <button type="button" className="btn btn--secondary" onClick={handleBack}>
              Keep browsing
            </button>
            <RefreshButton
              onRefresh={() => {
                if (isFetching) return;
                refetch();
              }}
              isFetching={isFetching}
              label="Refresh"
              title="Reload this product from the server"
            />
          </div>

          <p className="detail__note">
            Catalogue demo — this storefront is for product discovery; there is no cart or checkout.
          </p>
        </div>
      </div>
    </div>
  );
}

export default ProductDetailPage;
