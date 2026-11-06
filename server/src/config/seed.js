import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import env from './env.js';
import { connectDatabase, disconnectDatabase, getProviderName } from '../db/index.js';
import { getActiveProvider, getRepositories } from '../repositories/index.js';
import logger from '../utils/logger.js';
import { processAndStoreProductImage } from '../utils/imageProcessor.js';
import { DEFAULT_ADMIN, ROLES, PROTECTED_ENVIRONMENTS } from '../constants/appConstants.js';

/**
 * Idempotent development seed — **provider-neutral**.
 *
 * Phase 6 moved this file off Mongoose models onto the repository interfaces, so
 * the same fixture set can be loaded into MongoDB or MySQL with no source change.
 * Everything it writes goes through `getRepositories()`, which means the seed is
 * also a continuous end-to-end test of the repository layer on whichever provider
 * `DATABASE_PROVIDER` selects.
 *
 * Guarantees (all asserted by `tests/integration/seed.*.test.js`):
 *  - NEVER runs against production (hard refusal, `assertSeedableEnvironment`);
 *  - idempotent: identity is the natural key (email / nameNormalized / slug), so a
 *    second run creates nothing, updates nothing and leaves every `updatedAt`
 *    untouched — "no changes", not merely "no duplicates";
 *  - an existing admin's password is never reset or overwritten;
 *  - seeded admin is flagged `mustChangePassword` because the credential in this
 *    file is public knowledge and intended for local development only.
 */

const CATEGORY_SEED = [
  { name: 'Audio', description: 'Headphones, earbuds, speakers and hi-fi equipment.' },
  { name: 'Wearables', description: 'Smart watches, fitness bands and rings.' },
  { name: 'Computing', description: 'Laptops, keyboards, mice and desk accessories.' },
  { name: 'Home & Kitchen', description: 'Small appliances and everyday kitchen tools.' },
  { name: 'Photography', description: 'Cameras, lenses, tripods and lighting.' },
  { name: 'Accessories', description: 'Cables, chargers, cases and travel gear.' },
];

const BRAND_SEED = [
  { name: 'Aurora', description: 'Scandinavian design electronics.' },
  { name: 'NovaTech', description: 'Performance computing hardware.' },
  { name: 'Lumen', description: 'Lighting and photography equipment.' },
  { name: 'Vertex', description: 'Outdoor and fitness technology.' },
  { name: 'Kettle & Co', description: 'Kitchen appliances with a modern twist.' },
  { name: 'Trailmade', description: 'Durable bags and travel accessories.' },
];

/** `image: true` products get a generated gradient placeholder image. */
const PRODUCT_SEED = [
  {
    title: 'Aurora Studio Wireless Headphones',
    category: 'Audio',
    brand: 'Aurora',
    price: 24990,
    stock: 34,
    isActive: true,
    image: true,
    description:
      'Over-ear wireless headphones with hybrid active noise cancellation, 40 hour battery life and a lightweight aluminium frame tuned for studio accuracy.',
  },
  {
    title: 'Aurora Buds Pro',
    category: 'Audio',
    brand: 'Aurora',
    price: 8990,
    stock: 3,
    isActive: true,
    image: true,
    description:
      'Compact true-wireless earbuds with adaptive noise cancellation, IPX5 sweat resistance and a pocketable charging case for all-day listening.',
  },
  {
    title: 'NovaTech Portable Speaker Mini',
    category: 'Audio',
    brand: 'NovaTech',
    price: 4490,
    stock: 0,
    isActive: true,
    image: true,
    description:
      'Palm-sized Bluetooth speaker with a passive bass radiator, 12 hour runtime and a woven lanyard for taking your music anywhere.',
  },
  {
    title: 'Aurora Bookshelf Hi-Fi Speakers (Pair)',
    category: 'Audio',
    brand: 'Aurora',
    price: 34990,
    stock: 12,
    isActive: true,
    image: true,
    description:
      'Two-way passive bookshelf speakers with silk dome tweeters and a compact cabinet that suits desks and small living rooms alike.',
  },
  {
    title: 'Vertex Pulse Smart Watch',
    category: 'Wearables',
    brand: 'Vertex',
    price: 19990,
    stock: 27,
    isActive: true,
    image: true,
    description:
      'GPS smart watch with a 1.4 inch AMOLED display, 14 day battery life and 120+ workout profiles including trail running and open-water swimming.',
  },
  {
    title: 'Vertex Band 3 Fitness Tracker',
    category: 'Wearables',
    brand: 'Vertex',
    price: 3990,
    stock: 4,
    isActive: true,
    image: true,
    description:
      'Slim fitness band tracking heart rate, blood oxygen and sleep stages with a two week charge and 5ATM water resistance.',
  },
  {
    title: 'Lumen Ring Sleep Tracker',
    category: 'Wearables',
    brand: 'Lumen',
    price: 24990,
    stock: 8,
    isActive: false,
    image: true,
    description:
      'Titanium sleep and recovery ring with clinical-grade sensors and a 7 day battery, launching with limited stock in selected markets.',
  },
  {
    title: 'NovaTech Air 14 Laptop',
    category: 'Computing',
    brand: 'NovaTech',
    price: 94990,
    stock: 15,
    isActive: true,
    image: true,
    description:
      '14 inch aluminium laptop with a 12-core processor, 16GB memory, a 1TB SSD and a 18 hour battery for all-day professional work.',
  },
  {
    title: 'NovaTech Mechanical Keyboard TKL',
    category: 'Computing',
    brand: 'NovaTech',
    price: 7990,
    stock: 41,
    isActive: true,
    image: true,
    description:
      'Tenkeyless mechanical keyboard with hot-swappable switches, doubleshot PBT keycaps and per-key white backlighting.',
  },
  {
    title: 'Aurora Precision Mouse',
    category: 'Computing',
    brand: 'Aurora',
    price: 5490,
    stock: 2,
    isActive: true,
    image: true,
    description:
      'Ergonomic wireless mouse with a 26,000 DPI sensor, silent switches and a USB-C fast charge that delivers a full workday in five minutes.',
  },
  {
    title: 'NovaTech 4K USB-C Monitor 27"',
    category: 'Computing',
    brand: 'NovaTech',
    price: 42990,
    stock: 9,
    isActive: true,
    image: true,
    description:
      '27 inch 4K IPS monitor with 98% sRGB coverage, 90W USB-C power delivery and a height adjustable stand.',
  },
  {
    title: 'Kettle & Co Gooseneck Pour-Over Kettle',
    category: 'Home & Kitchen',
    brand: 'Kettle & Co',
    price: 6490,
    stock: 23,
    isActive: true,
    image: true,
    description:
      'Variable temperature gooseneck kettle with 0.9L capacity, 1 degree temperature control and a built-in brew timer.',
  },
  {
    title: 'Kettle & Co Burr Coffee Grinder',
    category: 'Home & Kitchen',
    brand: 'Kettle & Co',
    price: 11990,
    stock: 0,
    isActive: true,
    image: true,
    description:
      'Conical burr grinder with 40 grind settings, calibrated dosing and a low-retention chute for single-dose espresso workflows.',
  },
  {
    title: 'Lumen Cast Iron Skillet 26cm',
    category: 'Home & Kitchen',
    brand: 'Lumen',
    price: 3490,
    stock: 56,
    isActive: true,
    image: true,
    description:
      'Pre-seasoned cast iron skillet with a smooth cooking surface, oven safe to 260°C and a helper handle for balanced lifting.',
  },
  {
    title: 'Lumen Field Camera 35mm',
    category: 'Photography',
    brand: 'Lumen',
    price: 129990,
    stock: 5,
    isActive: true,
    image: true,
    description:
      'Full-frame mirrorless camera with a 33MP sensor, 8 stops of stabilisation and dual card slots for professional wildlife and travel work.',
  },
  {
    title: 'Lumen 50mm f/1.8 Prime Lens',
    category: 'Photography',
    brand: 'Lumen',
    price: 21990,
    stock: 18,
    isActive: true,
    image: true,
    description:
      'Compact 50mm prime lens with a nine-blade aperture, weather sealing and silent stepping motor autofocus for portraits and low light.',
  },
  {
    title: 'Lumen Carbon Travel Tripod',
    category: 'Photography',
    brand: 'Lumen',
    price: 15990,
    stock: 7,
    isActive: true,
    image: true,
    description:
      'Five-section carbon fibre tripod supporting 12kg, folding to 38cm with a ball head and quick release plate included.',
  },
  {
    title: 'Trailmade 25L Everyday Backpack',
    category: 'Accessories',
    brand: 'Trailmade',
    price: 7990,
    stock: 64,
    isActive: true,
    image: true,
    description:
      'Weather-resistant 25 litre backpack with a padded 16 inch laptop sleeve, quick-access top pocket and luggage pass-through strap.',
  },
  {
    title: 'Trailmade 140W GaN Charger',
    category: 'Accessories',
    brand: 'Trailmade',
    price: 5490,
    stock: 33,
    isActive: true,
    image: true,
    description:
      'Four-port GaN charger delivering 140W total, capable of fast charging a laptop and three devices simultaneously from a single outlet.',
  },
  {
    title: 'Aurora Braided USB-C Cable 2m',
    category: 'Accessories',
    brand: 'Aurora',
    price: 1290,
    stock: 120,
    isActive: true,
    image: false,
    description:
      'Braided 2 metre USB-C to USB-C cable rated for 240W power delivery and 480Mbps data, tested to 25,000 bend cycles.',
  },
  {
    title: 'Trailmade Hard Case for Earbuds',
    category: 'Accessories',
    brand: 'Trailmade',
    price: 990,
    stock: 1,
    isActive: false,
    image: false,
    description:
      'Impact-resistant moulded case with a soft microfibre lining, sized for compact true-wireless charging cases.',
  },
  {
    title: 'Vertex Trail Running Poles',
    category: 'Wearables',
    brand: 'Vertex',
    price: 8990,
    stock: 11,
    isActive: true,
    image: false,
    description:
      'Collapsible carbon trail running poles with a quick-lock mechanism, weighing 168 grams each and packing to 36cm.',
  },
];

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => {
    const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
    return entities[character];
  });
}

/** Deterministic gradient placeholder, rendered through the real image pipeline. */
function buildPlaceholderSvg(title, width = 1200, height = 900) {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  const from = `hsl(${hash}, 62%, 46%)`;
  const to = `hsl(${(hash + 48) % 360}, 58%, 26%)`;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${from}"/>
          <stop offset="1" stop-color="${to}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)"/>
      <text x="50%" y="52%" text-anchor="middle" fill="rgba(255,255,255,0.92)"
            font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="600">
        ${escapeXml(title)}
      </text>
    </svg>`,
  );
}

/**
 * Creates the default admin ONLY if it does not exist. Never touches an existing
 * account (so re-seeding cannot reset a real password).
 * @returns {Promise<{ created: boolean, email: string }>}
 */
async function seedAdmin({ users }) {
  const email = DEFAULT_ADMIN.email.toLowerCase();

  if (await users.existsByEmail(email)) {
    logger.info('seed: admin already exists, password left untouched', { email });
    return { created: false, email };
  }

  const passwordHash = await users.hashPassword(DEFAULT_ADMIN.password);
  await users.create({
    name: DEFAULT_ADMIN.name,
    email,
    passwordHash,
    role: ROLES.ADMIN,
    isActive: true,
    // Local development credential that is published in the repository, so the
    // first login must set a private password.
    mustChangePassword: true,
  });

  logger.info('seed: admin created (local development credentials)', { email });
  return { created: true, email };
}

/**
 * Upserts taxonomies by their natural key. A record that already exists is left
 * completely untouched — the id/createdAt/updatedAt of an existing row must not
 * move, or "the seed is idempotent" would only mean "it does not duplicate".
 */
async function seedTaxonomies({ brands, categories }) {
  const categoryIds = {};
  const brandIds = {};
  const categoryCounts = { created: 0, skipped: 0 };
  const brandCounts = { created: 0, skipped: 0 };

  for (const category of CATEGORY_SEED) {
    const nameNormalized = category.name.trim().toLowerCase();
    const existing = await categories.findByNameNormalized(nameNormalized);

    if (existing) {
      categoryIds[category.name] = existing.id;
      categoryCounts.skipped += 1;
      continue;
    }

    const record = await categories.create({
      name: category.name,
      description: category.description,
    });
    categoryIds[category.name] = record.id;
    categoryCounts.created += 1;
  }

  for (const brand of BRAND_SEED) {
    const nameNormalized = brand.name.trim().toLowerCase();
    const existing = await brands.findByNameNormalized(nameNormalized);

    if (existing) {
      brandIds[brand.name] = existing.id;
      brandCounts.skipped += 1;
      continue;
    }

    const record = await brands.create({ name: brand.name, description: brand.description });
    brandIds[brand.name] = record.id;
    brandCounts.created += 1;
  }

  return { categoryIds, brandIds, categories: categoryCounts, brands: brandCounts };
}

async function seedProducts({ products }, { categoryIds, brandIds }) {
  let created = 0;
  let skipped = 0;

  for (const seedProduct of PRODUCT_SEED) {
    const slug = slugOf(seedProduct.title);

    if (await products.existsBySlug(slug)) {
      skipped += 1;
      continue;
    }

    let image = '';
    let thumbnail = '';
    if (seedProduct.image) {
      const rendered = await sharp(buildPlaceholderSvg(seedProduct.title)).png().toBuffer();
      // Rendered through the real pipeline so seeded assets obey the same
      // 1200x1200 / 300x300 / metadata-stripping guarantees as uploads.
      const stored = await processAndStoreProductImage(rendered);
      image = stored.image;
      thumbnail = stored.thumbnail;
    }

    await products.create({
      payload: {
        title: seedProduct.title,
        description: seedProduct.description,
        price: seedProduct.price,
        stock: seedProduct.stock,
        brand: brandIds[seedProduct.brand],
        category: categoryIds[seedProduct.category],
        isActive: seedProduct.isActive,
      },
      slugSource: seedProduct.title,
      skuPrefix: seedProduct.category,
      image,
      thumbnail,
    });
    created += 1;
  }

  return { created, skipped };
}

/** Slug of a seeded title (kept local so the seed does not depend on helpers). */
function slugOf(title) {
  return String(title)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Hard environment guard, exported so it can be tested directly.
 * Seeding writes development fixtures and a known password — it must never be
 * possible to point it at production.
 * @param {string} nodeEnv
 */
export function assertSeedableEnvironment(nodeEnv = env.NODE_ENV) {
  if (PROTECTED_ENVIRONMENTS.includes(nodeEnv)) {
    const error = new Error(
      `Refusing to seed a "${nodeEnv}" database. Seeds are for local/test environments only.`,
    );
    error.code = 'SEED_FORBIDDEN_ENVIRONMENT';
    throw error;
  }
}

/**
 * Runs the seed. Exported so tests can invoke it programmatically.
 *
 * @param {{ repositories?: object }} [options] overrides the registry (tests)
 * @returns {Promise<object>} summary
 */
export async function runSeed(options = {}) {
  assertSeedableEnvironment(env.NODE_ENV);

  const repositories = options.repositories ?? getRepositories();
  const { users, brands, categories, products } = repositories;

  const admin = await seedAdmin({ users });
  const taxonomy = await seedTaxonomies({ brands, categories });
  const productSummary = await seedProducts({ products }, taxonomy);

  const summary = {
    provider: getActiveProvider() ?? getProviderName(),
    admin,
    // Kept as plain counters for backwards compatibility with the pre-P6 summary
    // shape (`summary.categories` has always been "how many were created").
    categories: taxonomy.categories.created,
    brands: taxonomy.brands.created,
    products: { total: PRODUCT_SEED.length, ...productSummary },
    detail: {
      categories: { total: CATEGORY_SEED.length, ...taxonomy.categories },
      brands: { total: BRAND_SEED.length, ...taxonomy.brands },
    },
    // The seed's idempotency contract in one number: a second run must report 0.
    changed:
      taxonomy.categories.created +
      taxonomy.brands.created +
      productSummary.created +
      (admin.created ? 1 : 0),
  };

  logger.info('seed: complete', summary);
  return summary;
}

/** CLI entrypoint: `npm run seed`. */
async function main() {
  logger.info('seed: starting', { env: env.NODE_ENV, provider: env.DATABASE_PROVIDER });
  await connectDatabase();
  try {
    const summary = await runSeed();
    if (!env.isTest) {
      process.stdout.write(
        [
          '',
          '──────────────────────────────────────────────────────────',
          ' Seed complete',
          '──────────────────────────────────────────────────────────',
          ` Provider      : ${summary.provider}`,
          ` Admin login   : ${DEFAULT_ADMIN.email}`,
          ` Admin password: ${DEFAULT_ADMIN.password}`,
          ' NOTE: development-only credentials. The account is flagged',
          '       mustChangePassword and must be changed on first login.',
          ` Categories    : ${summary.detail.categories.created} created, ${summary.detail.categories.skipped} kept`,
          ` Brands        : ${summary.detail.brands.created} created, ${summary.detail.brands.skipped} kept`,
          ` Products      : ${summary.products.created} created, ${summary.products.skipped} kept`,
          ` Changed       : ${summary.changed}`,
          '──────────────────────────────────────────────────────────',
          '',
        ].join('\n'),
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch(async (error) => {
    logger.error('seed: failed', { err: error });
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
}

export default runSeed;
