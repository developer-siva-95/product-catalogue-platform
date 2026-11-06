import mongoose from 'mongoose';
import { PRODUCT_LIMITS } from '../../constants/appConstants.js';

/** Stock badge thresholds surfaced to the storefront. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Product
 *
 * Concurrency & integrity notes:
 * - `versionKey` stays ENABLED (`__v`): admin updates must send the version they
 *   read, and Mongoose raises `VersionError` when two admins save concurrently.
 *   This is optimistic concurrency without needing a replica set / transactions.
 * - `sku` and `slug` are unique; `sku` is additionally sparse so legacy imports
 *   without a SKU can exist until the generator fills it in.
 * - Money is stored as a Number rounded to 2 decimals. For multi-currency or
 *   large-scale financial accuracy an integer minor-unit field would be better;
 *   documented as a known limitation because the catalogue spec fixes `price` as
 *   a Number in the major unit.
 */
const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [2, 'Title must be at least 2 characters'],
      maxlength: [
        PRODUCT_LIMITS.TITLE_MAX,
        `Title must be at most ${PRODUCT_LIMITS.TITLE_MAX} characters`,
      ],
    },
    slug: { type: String, required: true, trim: true, lowercase: true },
    sku: { type: String, trim: true, uppercase: true },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [PRODUCT_LIMITS.PRICE_MIN, 'Price cannot be negative'],
      max: [PRODUCT_LIMITS.PRICE_MAX, `Price must be at most ${PRODUCT_LIMITS.PRICE_MAX}`],
      set: (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value),
    },
    stock: {
      type: Number,
      required: [true, 'Stock is required'],
      min: [0, 'Stock cannot be negative'],
      max: [PRODUCT_LIMITS.STOCK_MAX, `Stock must be at most ${PRODUCT_LIMITS.STOCK_MAX}`],
      validate: {
        validator: Number.isInteger,
        message: 'Stock must be a whole number',
      },
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      maxlength: [
        PRODUCT_LIMITS.DESCRIPTION_MAX,
        `Description must be at most ${PRODUCT_LIMITS.DESCRIPTION_MAX} characters`,
      ],
    },
    image: { type: String, trim: true, default: '' },
    thumbnail: { type: String, trim: true, default: '' },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Brand',
      required: [true, 'Brand is required'],
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'Category is required'],
    },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    versionKey: '__v',
    // Required for real OCC: without this flag Mongoose 8 save() does not add
    // `__v` to the update filter, so a concurrent save would silently win.
    // With it, the second writer gets a VersionError -> HTTP 409.
    optimisticConcurrency: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ---- Uniqueness -----------------------------------------------------------
productSchema.index({ slug: 1 }, { unique: true, name: 'product_slug_unique' });
productSchema.index({ sku: 1 }, { unique: true, sparse: true, name: 'product_sku_unique_sparse' });

// ---- Filtering / sorting indexes (mirror the storefront sort contract) -----
// Admin table: brand + category + price range filtering in one index.
productSchema.index({ brand: 1, category: 1, price: 1 }, { name: 'product_brand_category_price' });
// Cursor pagination for `newest`.
productSchema.index({ isActive: 1, _id: -1 }, { name: 'product_active_newest' });
// Cursor pagination for `price_asc` / `price_desc` (exact sort key order).
productSchema.index({ isActive: 1, price: 1, _id: 1 }, { name: 'product_active_price_asc' });
productSchema.index({ isActive: 1, price: -1, _id: -1 }, { name: 'product_active_price_desc' });
// Single-facet filters used by the storefront sidebar.
productSchema.index({ isActive: 1, brand: 1 }, { name: 'product_active_brand' });
productSchema.index({ isActive: 1, category: 1 }, { name: 'product_active_category' });

// ---- Full-text search ------------------------------------------------------
productSchema.index(
  { title: 'text', description: 'text' },
  {
    name: 'product_text_search',
    weights: { title: 10, description: 2 },
    default_language: 'english',
  },
);

productSchema.virtual('inStock').get(function inStock() {
  return this.stock > 0;
});

/**
 * Coarse stock badge for the storefront:
 * `out_of_stock` (0), `low_stock` (1..threshold), `in_stock`.
 */
productSchema.virtual('stockStatus').get(function stockStatus() {
  if (this.stock <= 0) return 'out_of_stock';
  if (this.stock <= LOW_STOCK_THRESHOLD) return 'low_stock';
  return 'in_stock';
});

productSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

productSchema.statics.LOW_STOCK_THRESHOLD = LOW_STOCK_THRESHOLD;

export const Product = mongoose.models.Product ?? mongoose.model('Product', productSchema);
export default Product;
