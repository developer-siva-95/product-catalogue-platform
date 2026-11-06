import { useCallback, useState } from 'react';
import {
  useCreateBrandMutation,
  useDeleteBrandMutation,
  useGetBrandsQuery,
  useUpdateBrandMutation,
} from '../../api/apiSlice.js';
import { useAppDispatch } from '../../app/hooks.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { errorMessage } from '../../utils/format.js';
import { LIMITS } from '../../utils/constants.js';
import { showError, showSuccess } from '../../features/ui/uiSlice.js';
import Modal from '../../components/Modal.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import RefreshButton from '../../components/RefreshButton.jsx';
import Field from '../../components/Field.jsx';
import { LoadingBlock } from '../../components/Spinner.jsx';

/** Brand management with inline create/edit modal and guarded deletion. */
export function BrandsPage() {
  useDocumentTitle('Brands');
  const dispatch = useAppDispatch();
  // `refetchOnMountOrArgChange: true`: the taxonomy list is control data for the
  // storefront filters and the product forms, so re-entering the page re-reads it
  // instead of showing whatever the cache still holds.
  const { data, isLoading, isFetching, error, refetch } = useGetBrandsQuery(
    { sort: 'name' },
    { refetchOnMountOrArgChange: true },
  );
  const [createBrand, { isLoading: creating }] = useCreateBrandMutation();
  const [updateBrand, { isLoading: updating }] = useUpdateBrandMutation();
  const [deleteBrand, { isLoading: deleting }] = useDeleteBrandMutation();

  const [editor, setEditor] = useState(null); // { id?, name, description }
  const [editorError, setEditorError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const brands = data?.data ?? [];

  const openCreate = () => {
    setEditor({ name: '', description: '' });
    setEditorError(null);
  };

  const openEdit = (brand) => {
    setEditor({ id: brand.id, name: brand.name, description: brand.description ?? '' });
    setEditorError(null);
  };

  const handleSave = async () => {
    setEditorError(null);
    const name = editor.name.trim();
    if (name.length < LIMITS.NAME_MIN) {
      setEditorError(`Name must be at least ${LIMITS.NAME_MIN} characters`);
      return;
    }
    const payload = { name, description: editor.description.trim() };

    try {
      if (editor.id) {
        await updateBrand({ id: editor.id, ...payload }).unwrap();
        dispatch(showSuccess(`Brand “${name}” updated`));
      } else {
        await createBrand(payload).unwrap();
        dispatch(showSuccess(`Brand “${name}” created`));
      }
      setEditor(null);
    } catch (error_) {
      setEditorError(errorMessage(error_, 'Could not save the brand.'));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteBrand(pendingDelete.id).unwrap();
      dispatch(showSuccess(`Brand “${pendingDelete.name}” deleted`));
    } catch (error_) {
      dispatch(showError(errorMessage(error_, 'Could not delete the brand.')));
    }
    setPendingDelete(null);
  };

  /**
   * Manual refresh: the query hook's own `refetch()`, i.e. the existing
   * `/brands` endpoint with its existing argument. Nothing is cleared — the
   * table keeps rendering `data` while the request is in flight (`isFetching`), and
   * a failure leaves the loaded list in place with the error alert on top.
   */
  const handleRefresh = useCallback(() => {
    if (isFetching) return;
    refetch();
  }, [isFetching, refetch]);

  return (
    <section>
      <div className="page-heading">
        <div>
          <h2 style={{ fontSize: '1.25rem' }}>Brands</h2>
          <p className="page-heading__subtitle">
            Case-insensitive unique names · deleting is blocked while products reference them
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <RefreshButton
            onRefresh={handleRefresh}
            isFetching={isFetching}
            label="Refresh"
            title="Reload the brand list from the server"
          />
          <button type="button" className="btn btn--primary" onClick={openCreate}>
            + New brand
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert--error" role="alert">
          <span aria-hidden="true">⚠</span>
          <span>
            {errorMessage(error, 'Could not load brands.')}{' '}
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleRefresh}>
              Retry
            </button>
          </span>
        </div>
      ) : null}

      {isLoading ? <LoadingBlock label="Loading brands…" /> : null}

      {!isLoading && brands.length === 0 ? (
        <EmptyState
          icon="◈"
          title="No brands yet"
          description="Brands power the storefront’s brand filter and product forms."
          action={
            <button type="button" className="btn btn--primary" onClick={openCreate}>
              + New brand
            </button>
          }
        />
      ) : null}

      {brands.length > 0 ? (
        <div className="card" style={{ padding: 16 }}>
          <ul className="taxonomy-list">
            {brands.map((brand) => (
              <li key={brand.id}>
                <span>
                  <span className="taxonomy-list__name">{brand.name}</span>
                  <br />
                  <span className="taxonomy-list__meta">
                    /{brand.slug} · {brand.productCount} product(s) · {brand.activeProductCount}{' '}
                    active
                  </span>
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => openEdit(brand)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setPendingDelete(brand)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Modal
        open={Boolean(editor)}
        title={editor?.id ? 'Edit brand' : 'New brand'}
        onClose={() => setEditor(null)}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setEditor(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSave}
              disabled={creating || updating}
            >
              {creating || updating ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {editorError ? (
          <div className="alert alert--error" role="alert" style={{ marginBottom: 12 }}>
            {editorError}
          </div>
        ) : null}
        <Field label="Name" required>
          {(props) => (
            <input
              {...props}
              className="input"
              value={editor?.name ?? ''}
              onChange={(event) =>
                setEditor((current) => ({ ...current, name: event.target.value }))
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
              value={editor?.description ?? ''}
              onChange={(event) =>
                setEditor((current) => ({ ...current, description: event.target.value }))
              }
              maxLength={LIMITS.TAXONOMY_DESCRIPTION_MAX}
            />
          )}
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete brand?"
        message={
          pendingDelete
            ? `“${pendingDelete.name}” is used by ${pendingDelete.productCount} product(s). Deletion is refused while any product references it.`
            : ''
        }
        confirmLabel="Delete brand"
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

export default BrandsPage;
