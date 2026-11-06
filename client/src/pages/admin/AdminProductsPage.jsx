import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAppDispatch, useAppSelector } from '../../app/hooks.js';
import {
  adminProductLimitChanged,
  adminProductPageChanged,
  selectAdminProductLimit,
  selectAdminProductPage,
} from '../../features/pagination/paginationSlice.js';
import {
  useDeleteProductMutation,
  useGetAdminProductsQuery,
  useGetBrandsQuery,
  useGetCategoriesQuery,
  useUpdateStockMutation,
} from '../../api/apiSlice.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { ADMIN_PAGE_SIZES, ADMIN_SORT_OPTIONS, SEARCH_MIN_LENGTH } from '../../utils/constants.js';
import { errorMessage, formatPrice, stockBadgeClass } from '../../utils/format.js';
import { showError, showSuccess } from '../../features/ui/uiSlice.js';
import Pagination from '../../components/Pagination.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ProductThumb from '../../components/ProductThumb.jsx';
import RefreshButton from '../../components/RefreshButton.jsx';
import { LoadingBlock } from '../../components/Spinner.jsx';

/**
 * Admin product table — offset pagination with numbered pages.
 *
 * Filters reset the page to 1 (a filter change invalidates the current page
 * number); the page itself is kept in Redux so opening a product and coming back
 * returns to the same page.
 */
export function AdminProductsPage() {
  useDocumentTitle('Products');
  const dispatch = useAppDispatch();
  const page = useAppSelector(selectAdminProductPage);
  const limit = useAppSelector(selectAdminProductLimit);

  const [searchDraft, setSearchDraft] = useState('');
  const search = useDebouncedValue(searchDraft.trim(), 350);
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [isActive, setIsActive] = useState('');
  const [sort, setSort] = useState('-createdAt');
  const [pendingDelete, setPendingDelete] = useState(null);

  // Any filter change returns to the first page.
  useEffect(() => {
    dispatch(adminProductPageChanged(1));
  }, [dispatch, search, brand, category, isActive, sort, limit]);

  const queryArgs = {
    page,
    limit,
    search: search.length >= SEARCH_MIN_LENGTH ? search : '',
    brand,
    category,
    isActive,
    sort,
  };

  // Re-read on every entry: an admin returning to the table (or landing on another
  // page/filter) must see current rows, not the retained cache entry.
  const { data, isLoading, isFetching, error, refetch } = useGetAdminProductsQuery(queryArgs, {
    refetchOnMountOrArgChange: true,
  });
  const { data: brandsResponse } = useGetBrandsQuery({ sort: 'name' });
  const { data: categoriesResponse } = useGetCategoriesQuery({ sort: 'name' });

  const [deleteProduct, { isLoading: deleting }] = useDeleteProductMutation();
  const [updateStock] = useUpdateStockMutation();

  const products = data?.data ?? [];
  const meta = data?.meta;

  /** Manual refresh of the table: one request, no cache reset, no page reset. */
  const handleRefresh = useCallback(() => {
    if (isFetching) return;
    refetch();
  }, [isFetching, refetch]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteProduct(pendingDelete.id).unwrap();
      dispatch(showSuccess(`Deleted “${pendingDelete.title}”`));
      setPendingDelete(null);
    } catch (error_) {
      dispatch(showError(errorMessage(error_, 'Could not delete the product.')));
      setPendingDelete(null);
    }
  }, [deleteProduct, dispatch, pendingDelete]);

  const adjustStock = useCallback(
    async (product, delta) => {
      try {
        const result = await updateStock({ id: product.id, delta }).unwrap();
        dispatch(showSuccess(`Stock for “${product.title}” is now ${result.data.stock}`));
      } catch (error_) {
        dispatch(showError(errorMessage(error_, 'Could not update stock.')));
      }
    },
    [dispatch, updateStock],
  );

  return (
    <section>
      <div className="page-heading">
        <div>
          <h2 style={{ fontSize: '1.25rem' }}>Products</h2>
          <p className="page-heading__subtitle">
            {meta
              ? `${meta.total} product(s) · page ${meta.page} of ${meta.totalPages}`
              : 'Loading…'}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <RefreshButton
            onRefresh={handleRefresh}
            isFetching={isFetching}
            label="Refresh"
            title="Reload the product and inventory table from the server"
          />
          <Link className="btn btn--primary" to="/admin/products/new">
            + New product
          </Link>
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="form-row" style={{ gap: 12 }}>
          <div>
            <label className="visually-hidden" htmlFor="admin-search">
              Search products
            </label>
            <input
              id="admin-search"
              className="input"
              type="search"
              placeholder="Search by title or SKU…"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </div>
          <div>
            <label className="visually-hidden" htmlFor="admin-brand">
              Filter by brand
            </label>
            <select
              id="admin-brand"
              className="select"
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
            >
              <option value="">All brands</option>
              {(brandsResponse?.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="visually-hidden" htmlFor="admin-category">
              Filter by category
            </label>
            <select
              id="admin-category"
              className="select"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">All categories</option>
              {(categoriesResponse?.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="visually-hidden" htmlFor="admin-status">
              Filter by status
            </label>
            <select
              id="admin-status"
              className="select"
              value={isActive}
              onChange={(event) => setIsActive(event.target.value)}
            >
              <option value="">Any status</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
          <div>
            <label className="visually-hidden" htmlFor="admin-sort">
              Sort products
            </label>
            <select
              id="admin-sort"
              className="select"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              {ADMIN_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="visually-hidden" htmlFor="admin-page-size">
              Rows per page
            </label>
            <select
              id="admin-page-size"
              className="select"
              value={limit}
              onChange={(event) => dispatch(adminProductLimitChanged(Number(event.target.value)))}
            >
              {ADMIN_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error ? (
        <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {errorMessage(error, 'Could not load products.')}{' '}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => refetch()}>
              Retry
            </button>
          </span>
        </div>
      ) : null}

      {isLoading ? <LoadingBlock label="Loading products…" /> : null}

      {!isLoading && products.length === 0 ? (
        <EmptyState
          icon="☰"
          title="No products found"
          description="Adjust the filters, or create a new product to get started."
          action={
            <Link className="btn btn--primary" to="/admin/products/new">
              + New product
            </Link>
          }
        />
      ) : null}

      {products.length > 0 ? (
        <>
          <div className="table-wrapper" aria-busy={isFetching}>
            <table className="table">
              <caption className="visually-hidden">
                Catalogue products with stock controls and row actions
              </caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Brand / Category</th>
                  <th scope="col">Price</th>
                  <th scope="col">Stock</th>
                  <th scope="col">Status</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
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
                    <td className="text-muted">
                      {product.brand?.name ?? '—'}
                      <br />
                      <span className="text-subtle">{product.category?.name ?? '—'}</span>
                    </td>
                    <td>{formatPrice(product.price)}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span className={stockBadgeClass(product.stockStatus)}>
                          {product.stock}
                        </span>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => adjustStock(product, -1)}
                          disabled={product.stock <= 0}
                          aria-label={`Decrease stock for ${product.title}`}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => adjustStock(product, 1)}
                          aria-label={`Increase stock for ${product.title}`}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td>
                      <span
                        className={
                          product.isActive ? 'badge badge--success' : 'badge badge--neutral'
                        }
                      >
                        {product.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="table__actions">
                        <Link
                          className="btn btn--secondary btn--sm"
                          to={`/admin/products/${product.id}`}
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setPendingDelete(product)}
                          aria-label={`Delete ${product.title}`}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={meta?.page ?? 1}
            totalPages={meta?.totalPages ?? 1}
            total={meta?.total ?? products.length}
            onPageChange={(nextPage) => dispatch(adminProductPageChanged(nextPage))}
            disabled={isFetching}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete product?"
        message={
          pendingDelete
            ? `“${pendingDelete.title}” will be permanently removed, including its image files. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete product"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

export default AdminProductsPage;
