import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import * as categoryService from './service.js';

/** GET /api/v1/categories */
export const listCategories = async (req, res) => {
  const { search, sort } = req.validated?.query ?? {};
  const categories = await categoryService.listCategories({ search, sort });
  return sendSuccess(res, {
    message: 'Categories retrieved',
    data: categories,
    meta: { total: categories.length },
  });
};

/** GET /api/v1/categories/:id */
export const getCategory = async (req, res) => {
  const category = await categoryService.getCategory(req.params.id);
  return sendSuccess(res, { message: 'Category retrieved', data: category });
};

/** POST /api/v1/categories — admin only. */
export const createCategory = async (req, res) => {
  const category = await categoryService.createCategory(req.validated.body);
  return sendCreated(res, { message: 'Category created', data: category });
};

/** PUT /api/v1/categories/:id — admin only. */
export const updateCategory = async (req, res) => {
  const category = await categoryService.updateCategory(req.params.id, req.validated.body);
  return sendSuccess(res, { message: 'Category updated', data: category });
};

/** DELETE /api/v1/categories/:id — admin only. */
export const deleteCategory = async (req, res) => {
  const deleted = await categoryService.deleteCategory(req.params.id);
  return sendSuccess(res, { message: 'Category deleted', data: deleted });
};

export default { listCategories, getCategory, createCategory, updateCategory, deleteCategory };
