import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import * as brandService from './service.js';

/** GET /api/v1/brands — public list (used by storefront filters and admin selects). */
export const listBrands = async (req, res) => {
  const { search, sort } = req.validated?.query ?? {};
  const brands = await brandService.listBrands({ search, sort });
  return sendSuccess(res, {
    message: 'Brands retrieved',
    data: brands,
    meta: { total: brands.length },
  });
};

/** GET /api/v1/brands/:id — accepts an ObjectId or a slug. */
export const getBrand = async (req, res) => {
  const brand = await brandService.getBrand(req.params.id);
  return sendSuccess(res, { message: 'Brand retrieved', data: brand });
};

/** POST /api/v1/brands — admin only. */
export const createBrand = async (req, res) => {
  const brand = await brandService.createBrand(req.validated.body);
  return sendCreated(res, { message: 'Brand created', data: brand });
};

/** PUT /api/v1/brands/:id — admin only. */
export const updateBrand = async (req, res) => {
  const brand = await brandService.updateBrand(req.params.id, req.validated.body);
  return sendSuccess(res, { message: 'Brand updated', data: brand });
};

/** DELETE /api/v1/brands/:id — admin only; blocked while products reference it. */
export const deleteBrand = async (req, res) => {
  const deleted = await brandService.deleteBrand(req.params.id);
  return sendSuccess(res, { message: 'Brand deleted', data: deleted });
};

export default { listBrands, getBrand, createBrand, updateBrand, deleteBrand };
