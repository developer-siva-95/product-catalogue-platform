/**
 * Categories repository contract — identical semantics to brands, kept separate so
 * each domain can evolve without touching the other.
 */

/** Methods every categories repository must expose. */
export const CATEGORIES_REPOSITORY_METHODS = Object.freeze([
  'list',
  'findByIdentifier',
  'findById',
  'existsByName',
  'create',
  'update',
  'delete',
  'countProducts',
]);

export default { CATEGORIES_REPOSITORY_METHODS };
