import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { ApiError } from '../../utils/ApiError.js';
import { getRepositories } from '../../repositories/index.js';

/**
 * Brand domain service.
 *
 * Storage-agnostic: all queries go through the brands repository. Responsibilities
 * that stay here are the ones the API contract defines — duplicate detection
 * messages, the delete guard and its error payload.
 */

/**
 * Lists brands with optional case-insensitive search and product counts.
 * @param {{ search?: string, sort?: string }} query
 */
export async function listBrands(query = {}) {
  const { brands } = getRepositories();
  return brands.list(query);
}

/**
 * Finds a brand by canonical id or slug.
 * @param {string} identifier
 */
export async function getBrand(identifier) {
  const { brands } = getRepositories();
  const brand = await brands.findByIdentifier(identifier);
  if (!brand) throw ApiError.notFound('Brand not found', { code: 'BRAND_NOT_FOUND' });
  return brand;
}

/**
 * Creates a brand.
 *
 * The pre-check gives a friendly 409; the unique `nameNormalized` index is the real
 * guarantee and the repository retries the insert with a fresh slug when two
 * admins submit the same name simultaneously.
 *
 * @param {{ name: string, description?: string }} payload
 */
export async function createBrand({ name, description = '' }) {
  const { brands } = getRepositories();

  if (await brands.existsByName(name.trim().toLowerCase())) {
    throw ApiError.conflict('A brand with this name already exists', {
      code: 'BRAND_NAME_TAKEN',
      details: { name },
    });
  }

  return brands.create({ name, description });
}

/**
 * Updates a brand.
 * @param {string} id
 * @param {{ name?: string, description?: string }} payload
 */
export async function updateBrand(id, payload) {
  const { brands } = getRepositories();

  const existing = await brands.findById(id);
  if (!existing) throw ApiError.notFound('Brand not found', { code: 'BRAND_NOT_FOUND' });

  if (
    payload.name !== undefined &&
    payload.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()
  ) {
    const clash = await brands.existsByName(payload.name.trim().toLowerCase(), { excludeId: id });
    if (clash) {
      throw ApiError.conflict('A brand with this name already exists', {
        code: 'BRAND_NAME_TAKEN',
        details: { name: payload.name },
      });
    }
  }

  const updated = await brands.update(id, payload);
  if (!updated) throw ApiError.notFound('Brand not found', { code: 'BRAND_NOT_FOUND' });
  return updated;
}

/** Deletion is blocked while any product references the brand. */
export async function deleteBrand(id) {
  const { brands } = getRepositories();

  const brand = await brands.findById(id);
  if (!brand) throw ApiError.notFound('Brand not found', { code: 'BRAND_NOT_FOUND' });

  const { activeReferences, inactiveReferences } = await brands.countProducts(id);
  if (activeReferences > 0 || inactiveReferences > 0) {
    throw new ApiError(
      HTTP_STATUS.CONFLICT,
      `Cannot delete "${brand.name}": it is used by ${activeReferences + inactiveReferences} product(s). Reassign or delete those products first.`,
      { code: 'BRAND_IN_USE', details: { activeReferences, inactiveReferences } },
    );
  }

  const deleted = await brands.delete(id);
  if (!deleted) throw ApiError.notFound('Brand not found', { code: 'BRAND_NOT_FOUND' });
  return deleted;
}

export default { listBrands, getBrand, createBrand, updateBrand, deleteBrand };
