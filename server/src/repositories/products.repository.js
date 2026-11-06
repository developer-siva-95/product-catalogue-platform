/**
 * Products repository contract. Both providers must implement every method.
 *
 * Method semantics are fixed by the current (reference) MongoDB behaviour and are
 * what the shared contract test suite asserts against a real database:
 *
 *  - `listStorefront`  cursor pagination, active products only; the repository
 *                      fetches `limit + 1` rows and returns `{ records, fetched }`
 *                      so `hasNextPage` needs no count query.
 *  - `listAdmin`       offset pagination with an **exact** `total`.
 *  - `findById`        `null` when absent (never throws); callers map to 404.
 *  - `create`          returns the stored record; duplicate `slug`/`sku` must
 *                      surface as `ApiError` `DUPLICATE_KEY` (409).
 *  - `replaceFields`   writes the given editable fields; a version mismatch must
 *                      surface as `STALE_RESOURCE` (409) via optimistic locking.
 *                      Returns `{ record, previous }` so the caller can delete
 *                      superseded image files only after a durable write.
 *  - `updateStock`     atomic: `delta` (guarded against going below zero) or an
 *                      absolute `stock`; returns `{ record, insufficient, ... }`,
 *                      or `null` when the product is gone.
 *  - `deleteById`      `true` when a row was removed, `false` when it was absent.
 *  - `countByTaxonomy` counts per brand/category (total + active) for the
 *                      taxonomy endpoints' `productCount`/`activeProductCount`.
 *  - `existsBySlug` / `existsBySku` / `allocateSlug` / `allocateSku`
 *                      uniqueness probes used while assigning identities.
 *  - `collectReferencedImageFiles`
 *                      file names still referenced by any product; feeds the
 *                      orphan-image sweeper endpoint.
 *
 * A "record" returned by these methods is plain data shaped like the mapper input
 * in `product.mapper.js`: `_id`/`brand._id`/`category._id` are canonical 24-hex
 * **strings**, dates are `Date`, money is a `number`, `__v` is the OCC version.
 */

/** Methods every products repository must expose. */
export const PRODUCTS_REPOSITORY_METHODS = Object.freeze([
  'listStorefront',
  'listAdmin',
  'findById',
  'findAdminById',
  'existsBySlug',
  'existsBySku',
  'allocateSlug',
  'allocateSku',
  'create',
  'replaceFields',
  'updateStock',
  'deleteById',
  'countByTaxonomy',
  'collectReferencedImageFiles',
]);

export default { PRODUCTS_REPOSITORY_METHODS };
