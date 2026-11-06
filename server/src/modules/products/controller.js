import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { sweepOrphanedImages } from '../../utils/imageProcessor.js';
import * as productService from './service.js';

/** GET /api/v1/products — public storefront list (cursor pagination). */
export const listStorefrontProducts = async (req, res) => {
  const result = await productService.listStorefrontProducts(req.validated.query);
  return sendSuccess(res, {
    message: 'Products retrieved',
    data: result.items,
    meta: result.meta,
  });
};

/** GET /api/v1/products/:id — public detail by id or slug. */
export const getPublicProduct = async (req, res) => {
  const product = await productService.getPublicProduct(req.params.id);
  return sendSuccess(res, { message: 'Product retrieved', data: product });
};

/** GET /api/v1/admin/products — admin table (offset pagination, exact totals). */
export const listAdminProducts = async (req, res) => {
  const result = await productService.listAdminProducts(req.validated.query);
  return sendSuccess(res, {
    message: 'Products retrieved',
    data: result.items,
    meta: result.meta,
  });
};

/** GET /api/v1/admin/products/:id — admin detail (inactive products included). */
export const getAdminProduct = async (req, res) => {
  const product = await productService.getAdminProduct(req.params.id);
  return sendSuccess(res, { message: 'Product retrieved', data: product });
};

/** POST /api/v1/admin/products — create, with optional multipart image. */
export const createProduct = async (req, res) => {
  const product = await productService.createProduct(req.validated.body, req.file);
  return sendCreated(res, { message: 'Product created', data: product });
};

/** PUT /api/v1/admin/products/:id — full update (requires version). */
export const replaceProduct = async (req, res) => {
  const product = await productService.updateProduct(req.params.id, req.validated.body, {
    partial: false,
    file: req.file,
  });
  return sendSuccess(res, { message: 'Product updated', data: product });
};

/** PATCH /api/v1/admin/products/:id — partial update (requires version). */
export const patchProduct = async (req, res) => {
  const product = await productService.updateProduct(req.params.id, req.validated.body, {
    partial: true,
    file: req.file,
  });
  return sendSuccess(res, { message: 'Product updated', data: product });
};

/** PATCH /api/v1/admin/products/:id/stock — atomic stock adjustment. */
export const updateStock = async (req, res) => {
  const product = await productService.updateStock(req.params.id, req.validated.body);
  return sendSuccess(res, { message: 'Stock updated', data: product });
};

/** DELETE /api/v1/admin/products/:id */
export const deleteProduct = async (req, res) => {
  const deleted = await productService.deleteProduct(req.params.id);
  return sendSuccess(res, { message: 'Product deleted', data: deleted });
};

/**
 * POST /api/v1/admin/products/maintenance/sweep-orphans
 * Removes image files that no product references (crash recovery, manual cleanup).
 */
export const sweepOrphans = async (_req, res) => {
  const referenced = await productService.collectReferencedImageFiles();
  const result = await sweepOrphanedImages(referenced);
  return sendSuccess(res, { message: 'Orphan sweep complete', data: result });
};

export default {
  listStorefrontProducts,
  getPublicProduct,
  listAdminProducts,
  getAdminProduct,
  createProduct,
  replaceProduct,
  patchProduct,
  updateStock,
  deleteProduct,
  sweepOrphans,
};
