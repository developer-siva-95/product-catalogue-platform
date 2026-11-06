import { LIMITS } from './constants.js';

/** Initial (empty) form state for a new product. */
export const EMPTY_PRODUCT_FORM = {
  title: '',
  description: '',
  price: '',
  stock: '',
  brand: '',
  category: '',
  sku: '',
  isActive: true,
};

/**
 * Client-side validation mirroring the backend Zod rules.
 * Returns a `{ field: message }` map; an empty object means valid.
 */
export function validateProductForm(values) {
  const errors = {};

  const title = (values.title ?? '').trim();
  if (!title) errors.title = 'Title is required';
  else if (title.length < 2) errors.title = 'Title must be at least 2 characters';
  else if (title.length > LIMITS.TITLE_MAX) {
    errors.title = `Title must be at most ${LIMITS.TITLE_MAX} characters`;
  }

  const description = (values.description ?? '').trim();
  if (!description) errors.description = 'Description is required';
  else if (description.length > LIMITS.DESCRIPTION_MAX) {
    errors.description = `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`;
  }

  const price = Number(values.price);
  if (values.price === '' || values.price === null || values.price === undefined) {
    errors.price = 'Price is required';
  } else if (Number.isNaN(price)) errors.price = 'Price must be a number';
  else if (price < 0) errors.price = 'Price cannot be negative';
  else if (price > LIMITS.PRICE_MAX) errors.price = 'Price is too large';

  const stock = Number(values.stock);
  if (values.stock === '' || values.stock === null || values.stock === undefined) {
    errors.stock = 'Stock is required';
  } else if (!Number.isInteger(stock)) errors.stock = 'Stock must be a whole number';
  else if (stock < 0) errors.stock = 'Stock cannot be negative';
  else if (stock > LIMITS.STOCK_MAX) errors.stock = 'Stock is too large';

  if (!values.brand) errors.brand = 'Choose a brand';
  if (!values.category) errors.category = 'Choose a category';

  const sku = (values.sku ?? '').trim();
  if (sku && !/^[A-Z0-9-]{3,32}$/.test(sku.toUpperCase())) {
    errors.sku = 'SKU must be 3-32 characters (A-Z, 0-9, hyphen)';
  }

  return errors;
}

/**
 * Builds the multipart body.
 *
 * The API accepts `multipart/form-data` for both create and update; sending the
 * fields as strings is fine because the backend coerces and validates them.
 * `version` is the optimistic-concurrency token and is only sent on updates.
 */
export function buildProductFormData(values, { image = null, version = null } = {}) {
  const formData = new FormData();
  formData.append('title', (values.title ?? '').trim());
  formData.append('description', (values.description ?? '').trim());
  formData.append('price', String(values.price).trim());
  formData.append('stock', String(values.stock).trim());
  formData.append('brand', values.brand);
  formData.append('category', values.category);
  formData.append('isActive', values.isActive ? 'true' : 'false');
  const sku = (values.sku ?? '').trim();
  if (sku) formData.append('sku', sku.toUpperCase());
  if (version !== null && version !== undefined) formData.append('version', String(version));
  if (image) formData.append('image', image);
  return formData;
}

/** Maps an API product payload onto the editable form shape. */
export function productToFormValues(product) {
  if (!product) return { ...EMPTY_PRODUCT_FORM };
  return {
    title: product.title ?? '',
    description: product.description ?? '',
    price: product.price ?? '',
    stock: product.stock ?? '',
    brand: product.brand?.id ?? '',
    category: product.category?.id ?? '',
    sku: product.sku ?? '',
    isActive: product.isActive ?? true,
  };
}

/** Dirty check that ignores formatting-only differences (trim, numeric strings). */
export function isProductFormDirty(values, initialValues, image) {
  if (image) return true;
  const normalize = (form) => ({
    title: (form.title ?? '').trim(),
    description: (form.description ?? '').trim(),
    price: String(form.price ?? '').trim(),
    stock: String(form.stock ?? '').trim(),
    brand: form.brand ?? '',
    category: form.category ?? '',
    sku: (form.sku ?? '').trim().toUpperCase(),
    isActive: Boolean(form.isActive),
  });
  const current = normalize(values);
  const initial = normalize(initialValues);
  return Object.keys(current).some((key) => current[key] !== initial[key]);
}
