import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, authorize, enforcePasswordRotation } from '../../middlewares/auth.js';
import { handleProductImageUpload } from '../../middlewares/multer.js';
import { uploadLimiter } from '../../middlewares/rateLimiter.js';
import { noStoreDynamic, noStorePrivate } from '../../middlewares/noStore.js';
import { ROLES } from '../../constants/appConstants.js';
import {
  adminProductsQuerySchema,
  buildPatchProductSchema,
  createProductSchema,
  productIdSchema,
  stockUpdateSchema,
  storefrontProductsQuerySchema,
  updateProductSchema,
} from './validation.js';
import * as productController from './controller.js';

/**
 * Public storefront routes — mounted at /api/v1/products.
 * Only active products are ever visible here.
 */
export const productRouter = Router();

// Product JSON is generated per request; the browser must not answer a navigation
// from its HTTP cache (see middlewares/noStore.js). Scoped to this router only —
// the `/uploads` images keep their long-lived immutable policy.
productRouter.use(noStoreDynamic);

productRouter.get(
  '/',
  validate({ query: storefrontProductsQuerySchema }),
  productController.listStorefrontProducts,
);
productRouter.get('/:id', productController.getPublicProduct);

/**
 * Admin routes — mounted at /api/v1/admin/products.
 * Every route requires an admin session with a rotated password.
 */
export const adminProductRouter = Router();

adminProductRouter.use(noStorePrivate);
adminProductRouter.use(authenticate, authorize(ROLES.ADMIN), enforcePasswordRotation);

adminProductRouter.get(
  '/',
  validate({ query: adminProductsQuerySchema }),
  productController.listAdminProducts,
);

// Declared before `/:id` so the literal path can never be shadowed by the param.
adminProductRouter.post('/maintenance/sweep-orphans', productController.sweepOrphans);

adminProductRouter.get(
  '/:id',
  validate({ params: productIdSchema }),
  productController.getAdminProduct,
);

adminProductRouter.post(
  '/',
  uploadLimiter,
  handleProductImageUpload,
  validate({ body: createProductSchema }),
  productController.createProduct,
);

adminProductRouter.put(
  '/:id',
  uploadLimiter,
  handleProductImageUpload,
  validate({ params: productIdSchema, body: updateProductSchema }),
  productController.replaceProduct,
);

adminProductRouter.patch(
  '/:id/stock',
  validate({ params: productIdSchema, body: stockUpdateSchema }),
  productController.updateStock,
);

adminProductRouter.patch(
  '/:id',
  uploadLimiter,
  handleProductImageUpload,
  validate({ params: productIdSchema, body: (req) => buildPatchProductSchema(Boolean(req.file)) }),
  productController.patchProduct,
);

adminProductRouter.delete(
  '/:id',
  validate({ params: productIdSchema }),
  productController.deleteProduct,
);

export default { productRouter, adminProductRouter };
