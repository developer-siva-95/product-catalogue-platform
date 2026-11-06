/**
 * Brands repository contract.
 *
 * `list` must return each brand together with `productCount` and
 * `activeProductCount` (aggregate counts, computed by the provider — MongoDB uses
 * `$group`, MySQL a `LEFT JOIN … GROUP BY`), and `name`/`slug` uniqueness must be
 * enforced by the database so two concurrent creates cannot both succeed.

 *  - `existsByName`  case-insensitive uniqueness probe (`excludeId` for updates).
 *  - `findById`      canonical-id lookup used by the product service and guards.
 */

/** Methods every brands repository must expose. */
export const BRANDS_REPOSITORY_METHODS = Object.freeze([
  'list',
  'findByIdentifier',
  'findById',
  'existsByName',
  'create',
  'update',
  'delete',
  'countProducts',
]);

export default { BRANDS_REPOSITORY_METHODS };
