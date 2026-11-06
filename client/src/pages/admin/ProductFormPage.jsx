import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { useAppDispatch } from '../../app/hooks.js';
import {
  useCreateBrandMutation,
  useCreateCategoryMutation,
  useCreateProductMutation,
  useGetAdminProductQuery,
  useGetBrandsQuery,
  useGetCategoriesQuery,
  useUpdateProductMutation,
} from '../../api/apiSlice.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useUnsavedChangesWarning } from '../../hooks/useUnsavedChangesWarning.js';
import {
  buildProductFormData,
  EMPTY_PRODUCT_FORM,
  isProductFormDirty,
  productToFormValues,
  validateProductForm,
} from '../../utils/productForm.js';
import { LIMITS } from '../../utils/constants.js';
import { errorMessage, fieldErrorsFromApi } from '../../utils/format.js';
import { showError, showSuccess } from '../../features/ui/uiSlice.js';
import Field from '../../components/Field.jsx';
import ImageUpload from '../../components/ImageUpload.jsx';
import Modal from '../../components/Modal.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { LoadingBlock } from '../../components/Spinner.jsx';

const EMPTY_TAXONOMY_DRAFT = { name: '', description: '' };

/**
 * Create / edit product form.
 *
 * Guards implemented here:
 *  - **dirty state** tracked against a normalised snapshot;
 *  - **navigation guard** via `useBlocker` (in-app links, back/forward) plus a
 *    `beforeunload` warning for hard reloads;
 *  - **optimistic concurrency** — the `version` read with the product is sent back
 *    on save, and a 409 STALE_RESOURCE is surfaced with a "reload latest" action
 *    instead of silently overwriting a colleague's edit;
 *  - **inline taxonomy creation** so an admin never loses form input to create a
 *    missing brand/category in another tab.
 */
export function ProductFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  useDocumentTitle(isEdit ? 'Edit product' : 'New product');

  const {
    data: productResponse,
    isLoading: loadingProduct,
    refetch,
  } = useGetAdminProductQuery(id, {
    skip: !isEdit,
  });
  const product = productResponse?.data;

  const { data: brandsResponse, isLoading: brandsLoading } = useGetBrandsQuery({ sort: 'name' });
  const { data: categoriesResponse, isLoading: categoriesLoading } = useGetCategoriesQuery({
    sort: 'name',
  });

  const [createProduct, { isLoading: creating }] = useCreateProductMutation();
  const [updateProduct, { isLoading: updating }] = useUpdateProductMutation();
  const [createBrand, { isLoading: creatingBrand }] = useCreateBrandMutation();
  const [createCategory, { isLoading: creatingCategory }] = useCreateCategoryMutation();

  const [values, setValues] = useState({ ...EMPTY_PRODUCT_FORM });
  const [initialValues, setInitialValues] = useState({ ...EMPTY_PRODUCT_FORM });
  const [version, setVersion] = useState(0);
  const [image, setImage] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [taxonomyModal, setTaxonomyModal] = useState(null); // 'brand' | 'category'
  const [taxonomyDraft, setTaxonomyDraft] = useState(EMPTY_TAXONOMY_DRAFT);
  const [taxonomyError, setTaxonomyError] = useState(null);
  const submittedRef = useRef(false);

  // Hydrate the form once the product arrives.
  useEffect(() => {
    if (!product) return;
    const formValues = productToFormValues(product);
    setValues(formValues);
    setInitialValues(formValues);
    setVersion(product.version ?? 0);
  }, [product]);

  const dirty = isProductFormDirty(values, initialValues, image);
  useUnsavedChangesWarning(dirty);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !submittedRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const brands = useMemo(() => brandsResponse?.data ?? [], [brandsResponse]);
  const categories = useMemo(() => categoriesResponse?.data ?? [], [categoriesResponse]);

  const setField = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError(null);
    setConflict(null);

    const validationErrors = validateProductForm(values);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      setFormError('Please fix the highlighted fields before saving.');
      return;
    }

    const formData = buildProductFormData(values, { image, version: isEdit ? version : null });

    try {
      if (isEdit) {
        const result = await updateProduct({ id, body: formData, method: 'PUT' }).unwrap();
        setVersion(result.data.version);
        const nextValues = productToFormValues(result.data);
        setValues(nextValues);
        setInitialValues(nextValues);
        dispatch(showSuccess('Product updated'));
      } else {
        const result = await createProduct(formData).unwrap();
        dispatch(showSuccess(`Created “${result.data.title}”`));
      }
      submittedRef.current = true;
      setImage(null);
      navigate('/admin/products');
    } catch (error) {
      const fieldErrors = fieldErrorsFromApi(error);
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);

      if (error?.data?.error?.code === 'STALE_RESOURCE') {
        setConflict(errorMessage(error, 'This product changed elsewhere.'));
      } else {
        setFormError(errorMessage(error, 'Could not save the product.'));
        dispatch(showError(errorMessage(error, 'Could not save the product.')));
      }
    }
  };

  const handleReloadLatest = async () => {
    const refreshed = await refetch();
    const latest = refreshed.data?.data;
    if (latest) {
      const latestValues = productToFormValues(latest);
      setValues(latestValues);
      setInitialValues(latestValues);
      setVersion(latest.version ?? 0);
    }
    setConflict(null);
    dispatch(showSuccess('Loaded the latest version. Re-apply your changes.'));
  };

  const handleTaxonomySave = async () => {
    setTaxonomyError(null);
    const name = taxonomyDraft.name.trim();
    if (name.length < LIMITS.NAME_MIN) {
      setTaxonomyError(`Name must be at least ${LIMITS.NAME_MIN} characters`);
      return;
    }

    try {
      const payload = { name, description: taxonomyDraft.description.trim() };
      if (taxonomyModal === 'brand') {
        const created = await createBrand(payload).unwrap();
        setValues((current) => ({ ...current, brand: created.data.id }));
        dispatch(showSuccess(`Brand “${created.data.name}” created`));
      } else {
        const created = await createCategory(payload).unwrap();
        setValues((current) => ({ ...current, category: created.data.id }));
        dispatch(showSuccess(`Category “${created.data.name}” created`));
      }
      setTaxonomyModal(null);
      setTaxonomyDraft(EMPTY_TAXONOMY_DRAFT);
    } catch (error) {
      setTaxonomyError(errorMessage(error, 'Could not create it.'));
    }
  };

  if (isEdit && loadingProduct) return <LoadingBlock label="Loading product…" />;

  const busy = creating || updating;

  return (
    <section>
      <div className="page-heading">
        <div>
          <h2 style={{ fontSize: '1.25rem' }}>{isEdit ? 'Edit product' : 'New product'}</h2>
          <p className="page-heading__subtitle">
            {isEdit
              ? `Editing version ${version} · saving sends your version so concurrent edits are detected`
              : 'Slug and SKU are generated automatically when left blank'}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>
        <Link to="/admin/products" className="btn btn--ghost">
          Cancel
        </Link>
      </div>

      {conflict ? (
        <div className="alert alert--warning" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠</span>
          <span>
            {conflict}{' '}
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              onClick={handleReloadLatest}
            >
              Reload latest
            </button>
          </span>
        </div>
      ) : null}

      {formError ? (
        <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
          <span aria-hidden="true">⚠</span>
          <span>{formError}</span>
        </div>
      ) : null}

      <form className="card" style={{ padding: 24 }} onSubmit={handleSubmit} noValidate>
        <Field label="Title" error={errors.title} required>
          {(props) => (
            <input
              {...props}
              className="input"
              value={values.title}
              onChange={setField('title')}
              maxLength={LIMITS.TITLE_MAX}
              aria-invalid={errors.title ? 'true' : undefined}
            />
          )}
        </Field>

        <Field label="Description" error={errors.description} required>
          {(props) => (
            <textarea
              {...props}
              className="textarea"
              value={values.description}
              onChange={setField('description')}
              maxLength={LIMITS.DESCRIPTION_MAX}
              aria-invalid={errors.description ? 'true' : undefined}
            />
          )}
        </Field>

        <div className="form-row">
          <Field label="Price (INR)" error={errors.price} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={values.price}
                onChange={setField('price')}
                aria-invalid={errors.price ? 'true' : undefined}
              />
            )}
          </Field>
          <Field label="Stock" error={errors.stock} hint="Whole units available" required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="number"
                min={0}
                step="1"
                value={values.stock}
                onChange={setField('stock')}
                aria-invalid={errors.stock ? 'true' : undefined}
              />
            )}
          </Field>
        </div>

        <div className="form-row">
          <Field label="Brand" error={errors.brand} required>
            {(props) => (
              <div className="input-group">
                <select
                  {...props}
                  className="select"
                  value={values.brand}
                  onChange={setField('brand')}
                  disabled={brandsLoading}
                  aria-invalid={errors.brand ? 'true' : undefined}
                >
                  <option value="">Select a brand…</option>
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setTaxonomyDraft(EMPTY_TAXONOMY_DRAFT);
                    setTaxonomyError(null);
                    setTaxonomyModal('brand');
                  }}
                >
                  + New
                </button>
              </div>
            )}
          </Field>

          <Field label="Category" error={errors.category} required>
            {(props) => (
              <div className="input-group">
                <select
                  {...props}
                  className="select"
                  value={values.category}
                  onChange={setField('category')}
                  disabled={categoriesLoading}
                  aria-invalid={errors.category ? 'true' : undefined}
                >
                  <option value="">Select a category…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setTaxonomyDraft(EMPTY_TAXONOMY_DRAFT);
                    setTaxonomyError(null);
                    setTaxonomyModal('category');
                  }}
                >
                  + New
                </button>
              </div>
            )}
          </Field>
        </div>

        <div className="form-row">
          <Field
            label="SKU"
            error={errors.sku}
            hint="Optional — generated automatically (e.g. AUD-7K2M9QX)"
          >
            {(props) => (
              <input
                {...props}
                className="input mono"
                value={values.sku}
                onChange={setField('sku')}
                aria-invalid={errors.sku ? 'true' : undefined}
                placeholder="AUTO"
              />
            )}
          </Field>
          <div className="field">
            <span className="field__label">Visibility</span>
            <label className="checkbox">
              <input type="checkbox" checked={values.isActive} onChange={setField('isActive')} />
              Visible on the storefront
            </label>
            <span className="field__hint">Inactive products are hidden from shoppers.</span>
          </div>
        </div>

        <ImageUpload
          file={image}
          onChange={setImage}
          existingUrl={product?.image}
          error={errors.image}
        />

        <div className="form-actions">
          <span className="text-subtle push-right" aria-live="polite">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? <span className="btn__spinner" aria-hidden="true" /> : null}
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create product'}
          </button>
        </div>
      </form>

      <Modal
        open={Boolean(taxonomyModal)}
        title={taxonomyModal === 'brand' ? 'New brand' : 'New category'}
        description="Created immediately and selected in this form."
        onClose={() => setTaxonomyModal(null)}
        footer={
          <>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setTaxonomyModal(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleTaxonomySave}
              disabled={creatingBrand || creatingCategory}
            >
              {creatingBrand || creatingCategory ? 'Creating…' : 'Create'}
            </button>
          </>
        }
      >
        {taxonomyError ? (
          <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
            {taxonomyError}
          </div>
        ) : null}
        <Field label="Name" required>
          {(props) => (
            <input
              {...props}
              className="input"
              value={taxonomyDraft.name}
              onChange={(event) =>
                setTaxonomyDraft((current) => ({ ...current, name: event.target.value }))
              }
              maxLength={LIMITS.NAME_MAX}
              autoFocus
            />
          )}
        </Field>
        <Field label="Description" hint="Optional">
          {(props) => (
            <textarea
              {...props}
              className="textarea"
              style={{ minHeight: 80 }}
              value={taxonomyDraft.description}
              onChange={(event) =>
                setTaxonomyDraft((current) => ({ ...current, description: event.target.value }))
              }
              maxLength={LIMITS.TAXONOMY_DESCRIPTION_MAX}
            />
          )}
        </Field>
      </Modal>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        title="Discard unsaved changes?"
        message="You have unsaved changes on this product. Leaving now will discard them."
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </section>
  );
}

export default ProductFormPage;
