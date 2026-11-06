import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, authorize, enforcePasswordRotation } from '../../middlewares/auth.js';
import { ROLES } from '../../constants/appConstants.js';
import {
  brandIdSchema,
  createBrandSchema,
  listBrandsQuerySchema,
  updateBrandSchema,
} from './validation.js';
import * as brandController from './controller.js';

/**
 * Brand routes — mounted at /api/v1/brands.
 * Public: list + read. Admin: create/update/delete (with forced password rotation).
 */
export const brandRouter = Router();

const adminOnly = [authenticate, authorize(ROLES.ADMIN)];

brandRouter.get('/', validate({ query: listBrandsQuerySchema }), brandController.listBrands);
brandRouter.get('/:id', brandController.getBrand);

brandRouter.post(
  '/',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ body: createBrandSchema }),
  brandController.createBrand,
);

brandRouter.put(
  '/:id',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ params: brandIdSchema, body: updateBrandSchema }),
  brandController.updateBrand,
);

brandRouter.delete(
  '/:id',
  ...adminOnly,
  enforcePasswordRotation,
  validate({ params: brandIdSchema }),
  brandController.deleteBrand,
);

export default brandRouter;
