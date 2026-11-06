import { z } from 'zod';
import {
  PRODUCT_LIMITS,
  CURSOR_PAGINATION,
  PAGINATION,
  PRODUCT_SORTS,
} from '../../constants/appConstants.js';
import { objectIdParam } from '../../utils/validators.js';

/**
 * Product request schemas.
 *
 * All numeric/boolean fields use coercion because product writes arrive as
 * `multipart/form-data` when an image is attached — the browser sends strings.
 * The same schemas therefore serve JSON and multipart callers.
 */

/** Accepts true/'true'/'on'/1 and false/'false'/0 (but NOT the truthy string "false"). */
export const booleanFromForm = z.preprocess(
  (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    }
    return value;
  },
  z.boolean({ error: 'Expected a boolean value' }),
);

const title = z
  .string({ error: 'Title is required' })
  .trim()
  .min(2, 'Title must be at least 2 characters')
  .max(PRODUCT_LIMITS.TITLE_MAX, `Title must be at most ${PRODUCT_LIMITS.TITLE_MAX} characters`);

const description = z
  .string({ error: 'Description is required' })
  .trim()
  .min(1, 'Description is required')
  .max(
    PRODUCT_LIMITS.DESCRIPTION_MAX,
    `Description must be at most ${PRODUCT_LIMITS.DESCRIPTION_MAX} characters`,
  );

const price = z.coerce
  .number({ error: 'Price must be a number' })
  .min(PRODUCT_LIMITS.PRICE_MIN, 'Price cannot be negative')
  .max(PRODUCT_LIMITS.PRICE_MAX, `Price must be at most ${PRODUCT_LIMITS.PRICE_MAX}`);

const stock = z.coerce
  .number({ error: 'Stock must be a number' })
  .int('Stock must be a whole number')
  .min(0, 'Stock cannot be negative')
  .max(PRODUCT_LIMITS.STOCK_MAX, `Stock must be at most ${PRODUCT_LIMITS.STOCK_MAX}`);

const brand = objectIdParam;
const category = objectIdParam;

const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,32}$/, 'SKU must be 3-32 characters (A-Z, 0-9, hyphen)');

const isActive = booleanFromForm;

/** Optimistic concurrency token: the `__v` the client last read. */
const version = z.coerce
  .number({ error: 'Version is required for updates' })
  .int('Version must be an integer')
  .min(0, 'Version cannot be negative');

export const createProductSchema = z
  .object({
    title,
    description,
    price,
    stock,
    brand,
    category,
    sku: sku.optional(),
    isActive: isActive.optional().default(true),
  })
  .strict();

/** PUT: full replacement of the editable fields (image/sku optional). */
export const updateProductSchema = z
  .object({
    title,
    description,
    price,
    stock,
    brand,
    category,
    sku: sku.optional(),
    isActive: isActive.optional().default(true),
    version,
  })
  .strict();

/** PATCH: any subset, but a version is still mandatory (OCC contract). */
export const patchProductSchema = z
  .object({
    title: title.optional(),
    description: description.optional(),
    price: price.optional(),
    stock: stock.optional(),
    brand: brand.optional(),
    category: category.optional(),
    sku: sku.optional(),
    isActive: isActive.optional(),
    version,
  })
  .strict()
  .refine((data) => Object.keys(data).filter((key) => key !== 'version').length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * Patch schema that tolerates a body containing nothing but `version` when the
 * request carries an image — replacing the image alone is a valid edit.
 * @param {boolean} hasImage
 */
export function buildPatchProductSchema(hasImage) {
  const base = z
    .object({
      title: title.optional(),
      description: description.optional(),
      price: price.optional(),
      stock: stock.optional(),
      brand: brand.optional(),
      category: category.optional(),
      sku: sku.optional(),
      isActive: isActive.optional(),
      version,
    })
    .strict();

  if (hasImage) return base;
  return base.refine((data) => Object.keys(data).filter((key) => key !== 'version').length > 0, {
    message: 'Provide at least one field to update',
  });
}

export const stockUpdateSchema = z
  .object({
    // Either an atomic delta (+/-) or an absolute value — never both.
    delta: z.coerce
      .number()
      .int()
      .min(-PRODUCT_LIMITS.STOCK_MAX)
      .max(PRODUCT_LIMITS.STOCK_MAX)
      .optional(),
    stock: stock.optional(),
  })
  .strict()
  .refine((data) => (data.delta === undefined) !== (data.stock === undefined), {
    message: 'Provide exactly one of "delta" or "stock"',
  });

/** Admin list (offset pagination). */
export const adminProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(PAGINATION.DEFAULT_PAGE),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'Limit must be at least 1')
      .max(PAGINATION.MAX_LIMIT, `Limit cannot exceed ${PAGINATION.MAX_LIMIT}`)
      .optional()
      .default(PAGINATION.DEFAULT_LIMIT),
    search: z.string().trim().min(1).max(80).optional(),
    searchMode: z.enum(['regex', 'text']).optional().default('regex'),
    brand: objectIdParam.optional(),
    category: objectIdParam.optional(),
    isActive: booleanFromForm.optional(),
    sort: z
      .enum(['-createdAt', 'createdAt', 'price', '-price', 'title', '-title'])
      .optional()
      .default('-createdAt'),
  })
  .strict();

/** Storefront list (cursor pagination). */
export const storefrontProductsQuerySchema = z
  .object({
    cursor: z.string().trim().max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'Limit must be at least 1')
      .max(CURSOR_PAGINATION.MAX_LIMIT, `Limit cannot exceed ${CURSOR_PAGINATION.MAX_LIMIT}`)
      .optional()
      .default(CURSOR_PAGINATION.DEFAULT_LIMIT),
    search: z.string().trim().min(1, 'Search needs at least 1 character').max(80).optional(),
    minPrice: z.coerce.number().min(0, 'Minimum price cannot be negative').optional(),
    maxPrice: z.coerce.number().min(0, 'Maximum price cannot be negative').optional(),
    brand: objectIdParam.optional(),
    category: objectIdParam.optional(),
    sort: z.enum(PRODUCT_SORTS).optional().default('newest'),
  })
  .strict()
  .refine(
    (data) =>
      data.minPrice === undefined || data.maxPrice === undefined || data.minPrice <= data.maxPrice,
    { message: 'Minimum price cannot exceed maximum price', path: ['minPrice'] },
  );

export const productIdSchema = z.object({ id: objectIdParam });

export default {
  createProductSchema,
  updateProductSchema,
  patchProductSchema,
  buildPatchProductSchema,
  stockUpdateSchema,
  adminProductsQuerySchema,
  storefrontProductsQuerySchema,
  productIdSchema,
  booleanFromForm,
};
