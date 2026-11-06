/** Shared front-end constants. Client-side limits mirror the backend Zod rules. */

export const PRODUCT_SORTS = {
  NEWEST: 'newest',
  PRICE_ASC: 'price_asc',
  PRICE_DESC: 'price_desc',
};

export const SORT_OPTIONS = [
  { value: PRODUCT_SORTS.NEWEST, label: 'Newest arrivals' },
  { value: PRODUCT_SORTS.PRICE_ASC, label: 'Price: low to high' },
  { value: PRODUCT_SORTS.PRICE_DESC, label: 'Price: high to low' },
];

export const ADMIN_SORT_OPTIONS = [
  { value: '-createdAt', label: 'Newest first' },
  { value: 'createdAt', label: 'Oldest first' },
  { value: 'title', label: 'Title A–Z' },
  { value: '-title', label: 'Title Z–A' },
  { value: 'price', label: 'Price ascending' },
  { value: '-price', label: 'Price descending' },
];

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 350;
export const STOREFRONT_PAGE_SIZE = 12;
export const ADMIN_PAGE_SIZES = [10, 20, 50];

/**
 * Product count above which the storefront grid switches to row virtualization.
 *
 * Below it, every card stays mounted: a filtered search or a small catalogue then
 * keeps find-in-page and printing working over the whole result set, and the DOM
 * cost is trivial (≈13 nodes and 2 tab stops per card). Above it the grid windows
 * rows, bounding the DOM by the viewport instead of by how far the shopper has
 * scrolled. Documented here rather than inlined so the trade-off is discoverable.
 */
export const VIRTUALIZE_THRESHOLD = 60;

/** Mirrors server/src/constants/appConstants.js — keep in sync. */
export const LIMITS = {
  TITLE_MAX: 160,
  DESCRIPTION_MAX: 5000,
  NAME_MIN: 2,
  NAME_MAX: 60,
  TAXONOMY_DESCRIPTION_MAX: 500,
  PRICE_MAX: 1_000_000_000,
  STOCK_MAX: 1_000_000,
  PASSWORD_MIN: 10,
  PASSWORD_MAX: 128,
  IMAGE_MAX_BYTES: 5 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
};

export const ROLES = { ADMIN: 'admin', CUSTOMER: 'customer' };
