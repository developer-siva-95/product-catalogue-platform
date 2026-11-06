import { z } from 'zod';
import { TAXONOMY_LIMITS } from '../../constants/appConstants.js';
import { idParamSchema } from '../../utils/validators.js';

/**
 * Brand payload schemas. `strict()` rejects unknown fields so a typo (or an
 * attempt to set `nameNormalized` directly) fails loudly instead of silently.
 */
const name = z
  .string({ error: 'Brand name is required' })
  .trim()
  .min(
    TAXONOMY_LIMITS.NAME_MIN,
    `Brand name must be at least ${TAXONOMY_LIMITS.NAME_MIN} characters`,
  )
  .max(
    TAXONOMY_LIMITS.NAME_MAX,
    `Brand name must be at most ${TAXONOMY_LIMITS.NAME_MAX} characters`,
  );

/**
 * Create defaults the description to '' (so the stored document always has the
 * field). The *update* schema must not default it: Zod 4 materialises defaults
 * for absent keys, which would make `{}` look like `{ description: '' }` and
 * silently defeat the "at least one field" guard below.
 */
const description = z
  .string()
  .trim()
  .max(TAXONOMY_LIMITS.DESCRIPTION_MAX, 'Description is too long')
  .optional()
  .default('');

const descriptionPatch = z
  .string()
  .trim()
  .max(TAXONOMY_LIMITS.DESCRIPTION_MAX, 'Description is too long')
  .optional();

export const createBrandSchema = z
  .object({
    name,
    description,
  })
  .strict();

export const updateBrandSchema = z
  .object({
    name: name.optional(),
    description: descriptionPatch,
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listBrandsQuerySchema = z
  .object({
    search: z.string().trim().max(60).optional(),
    sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).optional().default('name'),
  })
  .strict();

export const brandIdSchema = idParamSchema;

export default { createBrandSchema, updateBrandSchema, listBrandsQuerySchema, brandIdSchema };
