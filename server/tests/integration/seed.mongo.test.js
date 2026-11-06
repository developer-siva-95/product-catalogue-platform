import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { configureRepositories, getRepositories } from '../../src/repositories/index.js';
import { defineSeedSuite } from '../contracts/seed-contract.js';
import { User } from '../../src/modules/auth/model.js';
import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';

configureRepositories('mongodb');

/**
 * Deterministic, comparable fingerprint of every stored record.
 *
 * `JSON.parse(JSON.stringify(...))` normalises BSON (ObjectId/Date already
 * serialise identically whether they come from Mongoose or from the MySQL
 * adapter below), so the two providers can be held to the very same expectation.
 */
async function snapshot() {
  const [brands, categories, products, users] = await Promise.all([
    Brand.find({}).sort({ nameNormalized: 1 }).lean(),
    Category.find({}).sort({ nameNormalized: 1 }).lean(),
    Product.find({}).sort({ slug: 1 }).lean(),
    User.find({}).sort({ email: 1 }).select('+passwordHash').lean(),
  ]);

  return {
    brands: JSON.parse(JSON.stringify(brands)),
    categories: JSON.parse(JSON.stringify(categories)),
    products: JSON.parse(JSON.stringify(products)),
    users: JSON.parse(JSON.stringify(users)),
    counts: {
      brands: brands.length,
      categories: categories.length,
      products: products.length,
      users: users.length,
    },
  };
}

defineSeedSuite({
  provider: 'mongodb',
  skip: false,
  repositories: () => getRepositories(),
  setup: async () => {
    await connectTestDB();
    await syncIndexes();
  },
  teardown: disconnectTestDB,
  reset: clearDatabase,
  snapshot,
  removeSomeProducts: async (count) => {
    const doomed = await Product.find({}).sort({ slug: 1 }).limit(count).select('_id').lean();
    await Product.deleteMany({ _id: { $in: doomed.map((doc) => doc._id) } });
  },
});
