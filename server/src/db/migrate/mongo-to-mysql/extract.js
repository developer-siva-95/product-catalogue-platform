import { Brand } from '../../../modules/brands/model.js';
import { Category } from '../../../modules/categories/model.js';
import { Product } from '../../../modules/products/model.js';
import { User } from '../../../modules/auth/model.js';
import { TABLES } from './mapping.js';

/**
 * Read-only extraction from MongoDB.
 *
 * This is the one place in the migration that touches Mongoose directly, and it
 * must: the migration has to see **everything**, including inactive products,
 * orphaned references and documents a model default would paper over. The
 * repository layer deliberately hides those, which is exactly right for the
 * application and exactly wrong for a data move.
 *
 * Reads use `.lean()` and an explicit sort, so two runs against an unchanged
 * database produce byte-identical source arrays (idempotency depends on it).
 */

const MODELS = {
  brands: Brand,
  categories: Category,
  products: Product,
  users: User,
};

/** Users carry `passwordHash` behind `select: false`; the migration needs it. */
const SELECTS = {
  users: '+passwordHash',
};

/**
 * @returns {Promise<{documents: Record<string, object[]>, counts: Record<string, number>}>}
 */
export async function extractDocuments() {
  const documents = {};
  const counts = {};

  for (const spec of TABLES) {
    const model = MODELS[spec.collection];
    if (!model) throw new Error(`No model registered for collection "${spec.collection}"`);

    const select = SELECTS[spec.collection];
    const query = model.find({}).sort({ _id: 1 }).lean();
    if (select) query.select(select);

    const docs = await query.exec();
    documents[spec.collection] = docs;
    counts[spec.collection] = docs.length;
  }

  return { documents, counts };
}

/** Maps extracted documents to MySQL rows through the shared mapping spec. */
export function mapRows(documents) {
  const rows = {};
  const documentsByCollection = {};

  for (const spec of TABLES) {
    const docs = documents[spec.collection] ?? [];
    documentsByCollection[spec.collection] = docs;
    rows[spec.collection] = docs.map((doc) => spec.row(doc));
  }

  return { rows, documents: documentsByCollection };
}
