import { Link } from 'react-router';
import {
  useGetAdminProductsQuery,
  useGetBrandsQuery,
  useGetCategoriesQuery,
} from '../../api/apiSlice.js';
import { useCallback } from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { errorMessage, formatDate, formatPrice } from '../../utils/format.js';
import ProductThumb from '../../components/ProductThumb.jsx';
import RefreshButton from '../../components/RefreshButton.jsx';

/**
 * Every query on this page subscribes with this option: dashboard figures are a
 * summary of live data and must never be a stale cache snapshot. Declared at module
 * scope so a new object identity is never handed to the hooks on re-render.
 */
const REFRESH_ON_MOUNT = { refetchOnMountOrArgChange: true };

function StatCard({ label, value, hint, loading }) {
  return (
    <div className="card stat-card">
      <span className="stat-card__label">{label}</span>
      <span className="stat-card__value">{loading ? '—' : value}</span>
      {hint ? <span className="stat-card__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Admin overview.
 *
 * Every number comes from an exact `countDocuments()` performed by the offset
 * endpoint (page size 1 — only the meta total is used), so dashboard figures can
 * never drift from the product table.
 */
export function AdminDashboardPage() {
  useDocumentTitle('Admin overview');

  // The four product queries are separate cache entries (different args), so one
  // refresh control has to drive all of them (see `handleRefresh` below).
  const mountOptions = REFRESH_ON_MOUNT;
  const {
    data: all,
    isLoading: loadingAll,
    isFetching: fetchingAll,
    error: errorAll,
    refetch: refetchAll,
  } = useGetAdminProductsQuery({ page: 1, limit: 1 }, mountOptions);
  const {
    data: active,
    isLoading: loadingActive,
    isFetching: fetchingActive,
    error: errorActive,
    refetch: refetchActive,
  } = useGetAdminProductsQuery({ page: 1, limit: 1, isActive: true }, mountOptions);
  const {
    data: inactive,
    isLoading: loadingInactive,
    isFetching: fetchingInactive,
    error: errorInactive,
    refetch: refetchInactive,
  } = useGetAdminProductsQuery({ page: 1, limit: 1, isActive: false }, mountOptions);
  const {
    data: brands,
    isLoading: loadingBrands,
    isFetching: fetchingBrands,
    error: errorBrands,
    refetch: refetchBrands,
  } = useGetBrandsQuery({ sort: 'name' }, mountOptions);
  const {
    data: categories,
    isLoading: loadingCategories,
    isFetching: fetchingCategories,
    error: errorCategories,
    refetch: refetchCategories,
  } = useGetCategoriesQuery({ sort: 'name' }, mountOptions);
  const {
    data: recent,
    isLoading: loadingRecent,
    isFetching: fetchingRecent,
    error: errorRecent,
    refetch: refetchRecent,
  } = useGetAdminProductsQuery({ page: 1, limit: 5, sort: '-createdAt' }, mountOptions);

  const isFetching =
    fetchingAll ||
    fetchingActive ||
    fetchingInactive ||
    fetchingBrands ||
    fetchingCategories ||
    fetchingRecent;

  /**
   * A failed refetch keeps the figures that are already on screen (RTK Query retains
   * `data` on a rejected refresh) and surfaces the failure, instead of quietly
   * implying the dashboard is current.
   */
  const error =
    errorAll ?? errorActive ?? errorInactive ?? errorBrands ?? errorCategories ?? errorRecent;

  /**
   * One click, six refetches: each call goes through that hook's own `refetch()`,
   * i.e. the existing endpoints with their existing arguments. Nothing is cleared
   * and no new fetching layer is introduced; the button is disabled while any of
   * them is in flight, so a second click cannot stack a duplicate round.
   */
  const handleRefresh = useCallback(() => {
    if (isFetching) return;
    refetchAll();
    refetchActive();
    refetchInactive();
    refetchBrands();
    refetchCategories();
    refetchRecent();
  }, [
    isFetching,
    refetchAll,
    refetchActive,
    refetchInactive,
    refetchBrands,
    refetchCategories,
    refetchRecent,
  ]);

  return (
    <section>
      {error ? (
        <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {errorMessage(
              error,
              'Could not refresh the dashboard — showing the last loaded figures.',
            )}
          </span>
        </div>
      ) : null}

      <div className="stat-grid">
        <StatCard
          label="Products"
          value={all?.meta?.total ?? 0}
          hint="All products in the catalogue"
          loading={loadingAll}
        />
        <StatCard
          label="Active"
          value={active?.meta?.total ?? 0}
          hint="Visible on the storefront"
          loading={loadingActive}
        />
        <StatCard
          label="Inactive"
          value={inactive?.meta?.total ?? 0}
          hint="Hidden from shoppers"
          loading={loadingInactive}
        />
        <StatCard
          label="Brands"
          value={brands?.meta?.total ?? brands?.data?.length ?? 0}
          hint="Used for storefront filters"
          loading={loadingBrands}
        />
        <StatCard
          label="Categories"
          value={categories?.meta?.total ?? categories?.data?.length ?? 0}
          hint="Flat taxonomy"
          loading={loadingCategories}
        />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div
          className="row"
          style={{ justifyContent: 'space-between', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}
        >
          <h2 style={{ fontSize: '1.0625rem' }}>Recently added</h2>
          <div className="row" style={{ gap: 8 }}>
            <RefreshButton
              onRefresh={handleRefresh}
              isFetching={isFetching}
              label="Refresh"
              title="Reload the dashboard figures and inventory table from the server"
            />
            <Link to="/admin/products" className="btn btn--secondary btn--sm">
              Manage products
            </Link>
          </div>
        </div>

        {loadingRecent ? (
          <div className="stack">
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" style={{ width: '80%' }} />
            <div className="skeleton skeleton-line" style={{ width: '60%' }} />
          </div>
        ) : recent?.data?.length ? (
          <div className="table-wrapper">
            <table className="table">
              <caption className="visually-hidden">The five most recently created products</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Price</th>
                  <th scope="col">Stock</th>
                  <th scope="col">Created</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <ProductThumb src={product.thumbnail} title={product.title} />
                        <span>
                          <span className="table__title">{product.title}</span>
                          <br />
                          <span className="table__subtitle">{product.sku ?? 'no sku'}</span>
                        </span>
                      </div>
                    </td>
                    <td>{formatPrice(product.price)}</td>
                    <td>
                      <span
                        className={
                          product.stockStatus === 'out_of_stock'
                            ? 'badge badge--danger'
                            : product.stockStatus === 'low_stock'
                              ? 'badge badge--warning'
                              : 'badge badge--success'
                        }
                      >
                        {product.stock}
                      </span>
                    </td>
                    <td className="text-muted">{formatDate(product.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link className="btn btn--ghost btn--sm" to={`/admin/products/${product.id}`}>
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted">
            No products yet. <Link to="/admin/products/new">Create your first product</Link>.
          </p>
        )}
      </div>
    </section>
  );
}

export default AdminDashboardPage;
