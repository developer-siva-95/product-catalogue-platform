import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { getProductImageDir } from '../../src/utils/imageProcessor.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createAdmin, createClient, createCustomer } from '../helpers/auth.js';
import {
  createBrandRecord,
  createCategoryRecord,
  createProductRecord,
} from '../helpers/factories.js';

async function imageBuffer(width = 1600, height = 900, format = 'jpeg') {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: '#224466' },
  });
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}

async function listImages() {
  try {
    return await fs.readdir(getProductImageDir());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

describe('admin products API (offset pagination, CRUD, OCC, stock)', () => {
  let app;
  let adminClient;
  let brand;
  let category;

  const validPayload = (overrides = {}) => ({
    title: 'NovaTech Air 14 Laptop',
    description: 'A 14 inch laptop with a 12 core processor and 18 hour battery.',
    price: 94990,
    stock: 15,
    brand: brand.id,
    category: category.id,
    ...overrides,
  });

  beforeAll(async () => {
    await connectTestDB();
    await syncIndexes();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
    resetAllRateLimits();
    brand = await createBrandRecord({ name: 'NovaTech' });
    category = await createCategoryRecord({ name: 'Computing' });
    await createAdmin({ email: 'prod-admin@test.local' });
    adminClient = createClient(app);
    await adminClient.login('prod-admin@test.local', 'Adm1n!Passw0rd');
  });

  describe('authentication and authorisation', () => {
    it('401s anonymous and 403s customer access to every admin route', async () => {
      const anonymous = await createClient(app).get('/api/v1/admin/products');
      expect(anonymous.status).toBe(401);

      await createCustomer({ email: 'prod-customer@test.local' });
      const customerClient = createClient(app);
      await customerClient.login('prod-customer@test.local', 'Cust0mer!Passw0rd');

      expect((await customerClient.get('/api/v1/admin/products')).status).toBe(403);
      expect((await customerClient.post('/api/v1/admin/products', validPayload())).status).toBe(
        403,
      );
      expect(
        (await customerClient.del('/api/v1/admin/products/000000000000000000000000')).status,
      ).toBe(403);
    });
  });

  describe('create', () => {
    it('creates a product with a generated slug and category-prefixed SKU', async () => {
      const response = await adminClient.post('/api/v1/admin/products', validPayload());
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        title: 'NovaTech Air 14 Laptop',
        slug: 'novatech-air-14-laptop',
        price: 94990,
        stock: 15,
        isActive: true,
        version: 0,
        stockStatus: 'in_stock',
        inStock: true,
      });
      expect(response.body.data.sku).toMatch(/^COM-[A-Z2-9]{7}$/);
      expect(response.body.data.brand).toMatchObject({ id: brand.id, name: 'NovaTech' });
      expect(response.body.data.category).toMatchObject({ id: category.id, name: 'Computing' });
    });

    it('accepts an explicit SKU and rejects a duplicate one', async () => {
      const first = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ sku: 'NOV-LAP0001' }),
      );
      expect(first.status).toBe(201);
      expect(first.body.data.sku).toBe('NOV-LAP0001');

      const duplicate = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ title: 'Another Product', sku: 'NOV-LAP0001' }),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('DUPLICATE_KEY');
    });

    it('rejects unknown brand/category references', async () => {
      const badBrand = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ brand: '000000000000000000000000' }),
      );
      expect(badBrand.status).toBe(400);
      expect(badBrand.body.error.code).toBe('BRAND_NOT_FOUND');

      const badCategory = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ category: '000000000000000000000000' }),
      );
      expect(badCategory.status).toBe(400);
      expect(badCategory.body.error.code).toBe('CATEGORY_NOT_FOUND');
    });

    it('validates the payload (negative price, long title, unknown fields)', async () => {
      const negative = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ price: -10 }),
      );
      expect(negative.status).toBe(400);
      expect(negative.body.error.details.some((detail) => detail.path === 'body.price')).toBe(true);

      const longTitle = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ title: 'x'.repeat(200) }),
      );
      expect(longTitle.status).toBe(400);

      const unknown = await adminClient.post(
        '/api/v1/admin/products',
        validPayload({ slug: 'hijacked' }),
      );
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('stores an uploaded image at the enforced limits and strips metadata', async () => {
      const buffer = await imageBuffer(2400, 1600, 'jpeg');
      const multipart = adminClient.builderFor('post', '/api/v1/admin/products');
      const response = await multipart
        .field('title', 'Camera With Photo')
        .field('description', 'A product photographed for the catalogue.')
        .field('price', '1299')
        .field('stock', '4')
        .field('brand', brand.id)
        .field('category', category.id)
        .attach('image', buffer, 'photo.jpg');

      expect(response.status).toBe(201);
      expect(response.body.data.image).toMatch(/^\/uploads\/products\/.+\.jpe?g$/);
      expect(response.body.data.thumbnail).toMatch(/-thumb\.jpe?g$/);
      expect(response.body.data.stockStatus).toBe('low_stock');

      const stored = await imageBuffer(1, 1);
      expect(stored).toBeDefined();
      const mainMeta = await sharp(
        `${getProductImageDir()}/${response.body.data.image.split('/').pop()}`,
      ).metadata();
      expect(mainMeta.width).toBeLessThanOrEqual(1200);
      expect(mainMeta.height).toBeLessThanOrEqual(1200);
      expect(mainMeta.exif).toBeUndefined();
    });

    it('rejects a disguised non-image and leaves no files behind', async () => {
      const before = await listImages();
      const multipart = adminClient.builderFor('post', '/api/v1/admin/products');
      const response = await multipart
        .field('title', 'Malicious Upload')
        .field('description', 'An upload that lies about its type.')
        .field('price', '10')
        .field('stock', '1')
        .field('brand', brand.id)
        .field('category', category.id)
        .attach('image', Buffer.from('this is definitely not an image'), {
          filename: 'payload.jpg',
          contentType: 'image/jpeg',
        });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await listImages()).toEqual(before);
      expect(await Product.countDocuments()).toBe(0);
    });

    it('cleans up the stored image when the database write fails', async () => {
      const before = await listImages();
      // Valid image, but a duplicate SKU forces the insert to fail after the
      // image has already been written to disk.
      await createProductRecord({ brand: brand._id, category: category._id, sku: 'DUP-00001' });

      const multipart = adminClient.builderFor('post', '/api/v1/admin/products');
      const response = await multipart
        .field('title', 'Doomed Product')
        .field('description', 'This product will fail to insert.')
        .field('price', '100')
        .field('stock', '1')
        .field('brand', brand.id)
        .field('category', category.id)
        .field('sku', 'DUP-00001')
        .attach('image', await imageBuffer(800, 800), 'photo.jpg');

      expect(response.status).toBe(409);
      const after = await listImages();
      expect(after.sort()).toEqual(before.sort());
    });
  });

  describe('offset pagination', () => {
    beforeEach(async () => {
      const records = [];
      for (let index = 0; index < 25; index += 1) {
        records.push({
          title: `Paged Product ${String(index).padStart(2, '0')}`,
          price: 1000 + index * 10,
          brand: brand._id,
          category: category._id,
          isActive: index % 5 !== 0,
        });
      }
      // Sequential creation keeps createdAt ordering deterministic.
      for (const record of records) {
        await createProductRecord(record);
      }
    });

    it('returns page metadata with an exact total', async () => {
      const first = await adminClient.get('/api/v1/admin/products?page=1&limit=10');
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(10);
      expect(first.body.meta).toMatchObject({
        page: 1,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNextPage: true,
        hasPrevPage: false,
      });

      const lastPage = await adminClient.get('/api/v1/admin/products?page=3&limit=10');
      expect(lastPage.body.data).toHaveLength(5);
      expect(lastPage.body.meta).toMatchObject({ hasNextPage: false, hasPrevPage: true });
    });

    it('returns an empty page (with totals intact) beyond the last page', async () => {
      const response = await adminClient.get('/api/v1/admin/products?page=99&limit=10');
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta).toMatchObject({ page: 99, total: 25, totalPages: 3 });
    });

    it('never returns the same product twice across pages', async () => {
      const seen = new Set();
      for (let page = 1; page <= 3; page += 1) {
        const response = await adminClient.get(`/api/v1/admin/products?page=${page}&limit=10`);
        for (const product of response.body.data) {
          expect(seen.has(product.id)).toBe(false);
          seen.add(product.id);
        }
      }
      expect(seen.size).toBe(25);
    });

    it('caps the page size and rejects out-of-range values', async () => {
      const tooBig = await adminClient.get('/api/v1/admin/products?limit=101');
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.details[0].path).toBe('query.limit');

      expect((await adminClient.get('/api/v1/admin/products?page=0')).status).toBe(400);
      expect((await adminClient.get('/api/v1/admin/products?page=abc')).status).toBe(400);
    });

    it('filters by brand, category, active state and search', async () => {
      const otherBrand = await createBrandRecord({ name: 'Aurora' });
      await createProductRecord({
        brand: otherBrand._id,
        category: category._id,
        title: 'Aurora One',
        isActive: false,
      });

      const byBrand = await adminClient.get(`/api/v1/admin/products?brand=${brand.id}`);
      expect(byBrand.body.meta.total).toBe(25);

      const otherBrandList = await adminClient.get(`/api/v1/admin/products?brand=${otherBrand.id}`);
      expect(otherBrandList.body.meta.total).toBe(1);

      const active = await adminClient.get('/api/v1/admin/products?isActive=true');
      expect(active.body.meta.total).toBe(20);

      const inactive = await adminClient.get('/api/v1/admin/products?isActive=false');
      expect(inactive.body.meta.total).toBe(6);

      const search = await adminClient.get('/api/v1/admin/products?search=Paged Product 07');
      expect(search.body.meta.total).toBe(1);

      const textSearch = await adminClient.get(
        '/api/v1/admin/products?search=Paged&searchMode=text',
      );
      expect(textSearch.status).toBe(200);
      expect(textSearch.body.meta.total).toBeGreaterThan(0);
    });

    it('sorts by price ascending and descending', async () => {
      const ascending = await adminClient.get('/api/v1/admin/products?sort=price&limit=5');
      const prices = ascending.body.data.map((product) => product.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));

      const descending = await adminClient.get('/api/v1/admin/products?sort=-price&limit=5');
      const descPrices = descending.body.data.map((product) => product.price);
      expect(descPrices).toEqual([...descPrices].sort((a, b) => b - a));
    });
  });

  describe('read, update and delete', () => {
    it('reads a single product including inactive ones', async () => {
      const record = await createProductRecord({
        brand: brand._id,
        category: category._id,
        isActive: false,
      });
      const response = await adminClient.get(`/api/v1/admin/products/${record.id}`);
      expect(response.status).toBe(200);
      expect(response.body.data.isActive).toBe(false);
      expect(response.body.data.version).toBe(0);
      expect(
        (await adminClient.get('/api/v1/admin/products/000000000000000000000000')).status,
      ).toBe(404);
    });

    it('patches a product and bumps the version', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload());
      const updated = await adminClient.patch(`/api/v1/admin/products/${created.body.data.id}`, {
        price: 89990,
        version: created.body.data.version,
      });

      expect(updated.status).toBe(200);
      expect(updated.body.data.price).toBe(89990);
      expect(updated.body.data.version).toBe(1);
    });

    it('regenerates the slug when the title changes but keeps it stable otherwise', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload());
      const id = created.body.data.id;

      const retitled = await adminClient.patch(`/api/v1/admin/products/${id}`, {
        title: 'NovaTech Air 16 Laptop',
        version: 0,
      });
      expect(retitled.body.data.slug).toBe('novatech-air-16-laptop');

      const described = await adminClient.patch(`/api/v1/admin/products/${id}`, {
        description: 'Updated description for the same product.',
        version: 1,
      });
      expect(described.body.data.slug).toBe('novatech-air-16-laptop');
    });

    it('rejects a stale version with 409 STALE_RESOURCE', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload());
      const id = created.body.data.id;

      await adminClient.patch(`/api/v1/admin/products/${id}`, { price: 1, version: 0 });

      const stale = await adminClient.patch(`/api/v1/admin/products/${id}`, {
        price: 2,
        version: 0,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_RESOURCE');
      expect(stale.body.error.details).toEqual({ providedVersion: 0, currentVersion: 1 });
    });

    it('requires a version on both PUT and PATCH', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload());
      const id = created.body.data.id;

      const noVersionPatch = await adminClient.patch(`/api/v1/admin/products/${id}`, { price: 5 });
      expect(noVersionPatch.status).toBe(400);

      const noVersionPut = await adminClient.put(`/api/v1/admin/products/${id}`, validPayload());
      expect(noVersionPut.status).toBe(400);
      expect(noVersionPut.body.error.details.some((detail) => detail.path === 'body.version')).toBe(
        true,
      );
    });

    it('replaces a product with PUT and validates required fields', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload());
      const id = created.body.data.id;

      const replaced = await adminClient.put(
        `/api/v1/admin/products/${id}`,
        validPayload({ title: 'Replaced Title', price: 5000, stock: 3, version: 0 }),
      );
      expect(replaced.status).toBe(200);
      expect(replaced.body.data).toMatchObject({ title: 'Replaced Title', price: 5000, stock: 3 });

      const partialPut = await adminClient.put(`/api/v1/admin/products/${id}`, {
        title: 'Only A Title',
        version: 1,
      });
      expect(partialPut.status).toBe(400);
    });

    it('replaces the image and deletes the superseded files', async () => {
      const createRequest = adminClient.builderFor('post', '/api/v1/admin/products');
      const created = await createRequest
        .field('title', 'Image Lifecycle Product')
        .field('description', 'Testing image replacement cleanup.')
        .field('price', '250')
        .field('stock', '5')
        .field('brand', brand.id)
        .field('category', category.id)
        .attach('image', await imageBuffer(900, 900), 'first.jpg');

      expect(created.status).toBe(201);
      const firstImage = created.body.data.image;
      const firstThumb = created.body.data.thumbnail;

      const replaceRequest = adminClient.builderFor(
        'patch',
        `/api/v1/admin/products/${created.body.data.id}`,
      );
      const replaced = await replaceRequest
        .field('version', String(created.body.data.version))
        .attach('image', await imageBuffer(1000, 1000, 'png'), 'second.png');

      expect(replaced.status).toBe(200);
      expect(replaced.body.data.image).not.toBe(firstImage);
      expect(replaced.body.data.image).toMatch(/\.webp$/);

      const files = await listImages();
      expect(files).not.toContain(firstImage.split('/').pop());
      expect(files).not.toContain(firstThumb.split('/').pop());
      expect(files).toContain(replaced.body.data.image.split('/').pop());
    });

    it('deletes a product and removes its images', async () => {
      const deleteImageRequest = adminClient.builderFor('post', '/api/v1/admin/products');
      const created = await deleteImageRequest
        .field('title', 'Doomed Image Product')
        .field('description', 'This product will be deleted.')
        .field('price', '99')
        .field('stock', '1')
        .field('brand', brand.id)
        .field('category', category.id)
        .attach('image', await imageBuffer(800, 800), 'doomed.jpg');

      const imageName = created.body.data.image.split('/').pop();
      const deleted = await adminClient.del(`/api/v1/admin/products/${created.body.data.id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data.title).toBe('Doomed Image Product');

      expect(await Product.countDocuments()).toBe(0);
      expect(await listImages()).not.toContain(imageName);
      expect((await adminClient.get(`/api/v1/admin/products/${created.body.data.id}`)).status).toBe(
        404,
      );
    });
  });

  describe('atomic stock updates', () => {
    it('increments and decrements atomically', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload({ stock: 10 }));
      const id = created.body.data.id;

      const sold = await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: -3 });
      expect(sold.status).toBe(200);
      expect(sold.body.data.stock).toBe(7);

      const restocked = await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: 5 });
      expect(restocked.body.data.stock).toBe(12);
    });

    it('refuses to drive stock negative and reports what is available', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload({ stock: 2 }));
      const response = await adminClient.patch(
        `/api/v1/admin/products/${created.body.data.id}/stock`,
        { delta: -5 },
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(response.body.error.details).toEqual({ available: 2, requested: 5 });

      const product = await Product.findById(created.body.data.id);
      expect(product.stock).toBe(2);
    });

    it('sets an absolute stock value and validates the payload', async () => {
      const created = await adminClient.post('/api/v1/admin/products', validPayload({ stock: 2 }));
      const id = created.body.data.id;

      const absolute = await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { stock: 42 });
      expect(absolute.body.data.stock).toBe(42);

      expect(
        (await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: 1, stock: 5 }))
          .status,
      ).toBe(400);
      expect((await adminClient.patch(`/api/v1/admin/products/${id}/stock`, {})).status).toBe(400);
      expect(
        (await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { stock: -1 })).status,
      ).toBe(400);
    });

    it('404s stock updates for unknown products', async () => {
      const response = await adminClient.patch(
        '/api/v1/admin/products/000000000000000000000000/stock',
        { delta: 1 },
      );
      expect(response.status).toBe(404);
    });
  });


  /**
   * Admin payloads are authenticated and change on every write: they must not be
   * stored by the browser, and must be `private` so no shared cache (CDN/reverse
   * proxy) keeps a copy either.
   */
  describe('cache headers', () => {
    it('marks admin product responses private and no-store', async () => {
      const response = await adminClient.get('/api/v1/admin/products?limit=5');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['cache-control']).toContain('private');
      expect(response.headers.vary ?? '').toMatch(/Cookie/);
    });

    it('applies the policy to unauthenticated rejections on the same router', async () => {
      const anonymous = await createClient(app).get('/api/v1/admin/products');
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers['cache-control']).toContain('no-store');
    });
  });
});
