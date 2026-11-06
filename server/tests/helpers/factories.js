import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';
import { slugify } from '../../src/utils/slugify.js';
import { generateSku } from '../../src/utils/skuGenerator.js';

/** Direct-model factories: fast fixtures for integration specs. */
let counter = 0;
function unique(prefix) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createBrandRecord(overrides = {}) {
  const name = overrides.name ?? unique('Brand');
  return Brand.create({
    name,
    nameNormalized: name.toLowerCase(),
    slug: overrides.slug ?? slugify(name),
    description: overrides.description ?? '',
  });
}

export async function createCategoryRecord(overrides = {}) {
  const name = overrides.name ?? unique('Category');
  return Category.create({
    name,
    nameNormalized: name.toLowerCase(),
    slug: overrides.slug ?? slugify(name),
    description: overrides.description ?? '',
  });
}

export async function createProductRecord(overrides = {}) {
  const title = overrides.title ?? unique('Product');
  const brand = overrides.brand ?? (await createBrandRecord())._id;
  const category = overrides.category ?? (await createCategoryRecord())._id;

  return Product.create({
    title,
    slug: overrides.slug ?? slugify(title),
    sku: overrides.sku ?? generateSku({ prefix: 'TST' }),
    price: overrides.price ?? 1000,
    stock: overrides.stock ?? 10,
    description: overrides.description ?? 'A product used in tests.',
    image: overrides.image ?? '',
    thumbnail: overrides.thumbnail ?? '',
    brand,
    category,
    isActive: overrides.isActive ?? true,
  });
}

export default { createBrandRecord, createCategoryRecord, createProductRecord };
