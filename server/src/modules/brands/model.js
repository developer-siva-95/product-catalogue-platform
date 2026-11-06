import mongoose from 'mongoose';
import { TAXONOMY_LIMITS } from '../../constants/appConstants.js';

/**
 * Brand
 * - `nameNormalized` guarantees case-insensitive uniqueness at the DB level
 *   ("Acme" and "acme" cannot coexist), which application-level checks alone
 *   cannot do under concurrency.
 * - `slug` is the public, stable URL identity.
 */
const brandSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Brand name is required'],
      trim: true,
      minlength: [
        TAXONOMY_LIMITS.NAME_MIN,
        `Brand name must be at least ${TAXONOMY_LIMITS.NAME_MIN} characters`,
      ],
      maxlength: [
        TAXONOMY_LIMITS.NAME_MAX,
        `Brand name must be at most ${TAXONOMY_LIMITS.NAME_MAX} characters`,
      ],
    },
    nameNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    slug: { type: String, required: true, trim: true, lowercase: true },
    description: {
      type: String,
      trim: true,
      maxlength: [TAXONOMY_LIMITS.DESCRIPTION_MAX, 'Description is too long'],
      default: '',
    },
    logo: { type: String, trim: true, default: '' },
  },
  { timestamps: true, versionKey: false },
);

brandSchema.index({ nameNormalized: 1 }, { unique: true, name: 'brand_name_normalized_unique' });
brandSchema.index({ slug: 1 }, { unique: true, name: 'brand_slug_unique' });

/** Keeps nameNormalized in sync no matter which write path is used.
 *  Mongoose 9 removed the `next()` callback from pre middleware; the hook is
 *  synchronous and simply returns, which Mongoose treats as resolved. */
brandSchema.pre('validate', function syncNormalized() {
  if (this.name) this.nameNormalized = this.name.trim().toLowerCase();
});

brandSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.nameNormalized;
    return ret;
  },
});

export const Brand = mongoose.models.Brand ?? mongoose.model('Brand', brandSchema);
export default Brand;
