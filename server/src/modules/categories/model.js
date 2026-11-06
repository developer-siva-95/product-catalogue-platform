import mongoose from 'mongoose';
import { TAXONOMY_LIMITS } from '../../constants/appConstants.js';

/**
 * Category — flat taxonomy (no nesting) kept deliberately simple: the catalogue
 * requirements do not need hierarchy, and a flat set keeps storefront filters
 * and product forms trivial while remaining index-friendly.
 */
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      minlength: [
        TAXONOMY_LIMITS.NAME_MIN,
        `Category name must be at least ${TAXONOMY_LIMITS.NAME_MIN} characters`,
      ],
      maxlength: [
        TAXONOMY_LIMITS.NAME_MAX,
        `Category name must be at most ${TAXONOMY_LIMITS.NAME_MAX} characters`,
      ],
    },
    nameNormalized: { type: String, required: true, trim: true, lowercase: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    description: {
      type: String,
      trim: true,
      maxlength: [TAXONOMY_LIMITS.DESCRIPTION_MAX, 'Description is too long'],
      default: '',
    },
  },
  { timestamps: true, versionKey: false },
);

categorySchema.index(
  { nameNormalized: 1 },
  { unique: true, name: 'category_name_normalized_unique' },
);
categorySchema.index({ slug: 1 }, { unique: true, name: 'category_slug_unique' });

/** Keeps nameNormalized in sync no matter which write path is used.
 *  Mongoose 9 removed the `next()` callback from pre middleware; the hook is
 *  synchronous and simply returns, which Mongoose treats as resolved. */
categorySchema.pre('validate', function syncNormalized() {
  if (this.name) this.nameNormalized = this.name.trim().toLowerCase();
});

categorySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.nameNormalized;
    return ret;
  },
});

export const Category = mongoose.models.Category ?? mongoose.model('Category', categorySchema);
export default Category;
