import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { ApiError } from '../../utils/ApiError.js';
import { getRepositories } from '../../repositories/index.js';

/**
 * Category domain service — mirrors the brand service contract so the frontend can
 * treat both taxonomies identically (same envelope, same error codes), while all
 * storage access goes through the categories repository.
 */

export async function listCategories(query = {}) {
  const { categories } = getRepositories();
  return categories.list(query);
}

export async function getCategory(identifier) {
  const { categories } = getRepositories();
  const category = await categories.findByIdentifier(identifier);
  if (!category) throw ApiError.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });
  return category;
}

export async function createCategory({ name, description = '' }) {
  const { categories } = getRepositories();

  if (await categories.existsByName(name.trim().toLowerCase())) {
    throw ApiError.conflict('A category with this name already exists', {
      code: 'CATEGORY_NAME_TAKEN',
      details: { name },
    });
  }

  return categories.create({ name, description });
}

export async function updateCategory(id, payload) {
  const { categories } = getRepositories();

  const existing = await categories.findById(id);
  if (!existing) throw ApiError.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });

  if (
    payload.name !== undefined &&
    payload.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()
  ) {
    const clash = await categories.existsByName(payload.name.trim().toLowerCase(), {
      excludeId: id,
    });
    if (clash) {
      throw ApiError.conflict('A category with this name already exists', {
        code: 'CATEGORY_NAME_TAKEN',
        details: { name: payload.name },
      });
    }
  }

  const updated = await categories.update(id, payload);
  if (!updated) throw ApiError.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });
  return updated;
}

/** Deletion is blocked while any product references the category. */
export async function deleteCategory(id) {
  const { categories } = getRepositories();

  const category = await categories.findById(id);
  if (!category) throw ApiError.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });

  const { activeReferences, inactiveReferences } = await categories.countProducts(id);
  if (activeReferences > 0 || inactiveReferences > 0) {
    throw new ApiError(
      HTTP_STATUS.CONFLICT,
      `Cannot delete "${category.name}": it is used by ${activeReferences + inactiveReferences} product(s). Reassign or delete those products first.`,
      { code: 'CATEGORY_IN_USE', details: { activeReferences, inactiveReferences } },
    );
  }

  const deleted = await categories.delete(id);
  if (!deleted) throw ApiError.notFound('Category not found', { code: 'CATEGORY_NOT_FOUND' });
  return deleted;
}

export default { listCategories, getCategory, createCategory, updateCategory, deleteCategory };
