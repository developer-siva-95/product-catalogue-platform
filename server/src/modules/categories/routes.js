import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, authorize, enforcePasswordRotation } from '../../middlewares/auth.js';
import { ROLES } from '../../constants/appConstants.js';
import {
  categoryIdSchema,
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from './validation.js';
import * as categoryController from './controller.js';

/** Category routes — mounted at /api/v1/categories. */
export const categoryRouter = Router();

const adminOnly = [authenticate, authorize(ROLES.ADMIN)];

categoryRouter.get(
  '/',
  validate({ query: listCategoriesQuerySchema }),
  categoryController.listCategories,
);
categoryRouter.get('/:id', categoryController.getCategory);

categoryRouter.post(
  '/',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ body: createCategorySchema }),
  categoryController.createCategory,
);

categoryRouter.put(
  '/:id',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ params: categoryIdSchema, body: updateCategorySchema }),
  categoryController.updateCategory,
);

categoryRouter.delete(
  '/:id',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ params: categoryIdSchema }),
  categoryController.deleteCategory,
);

export default categoryRouter;
