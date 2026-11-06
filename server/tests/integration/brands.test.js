import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { Brand } from '../../src/modules/brands/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createAdmin, createCustomer, createClient } from '../helpers/auth.js';
import { createBrandRecord, createProductRecord } from '../helpers/factories.js';

describe('brands API', () => {
  let app;
  let admin;
  let adminClient;

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
    admin = await createAdmin({ email: 'brand-admin@test.local' });
    adminClient = createClient(app);
    await adminClient.login('brand-admin@test.local', 'Adm1n!Passw0rd');
  });

  describe('public reads', () => {
    it('returns an empty list when there are no brands', async () => {
      const response = await createClient(app).get('/api/v1/brands');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, data: [] });
      expect(response.body.meta.total).toBe(0);
    });

    it('lists brands alphabetically with product counts', async () => {
      const zebra = await createBrandRecord({ name: 'Zebra' });
      const acme = await createBrandRecord({ name: 'Acme' });
      await createProductRecord({ brand: acme._id });
      await createProductRecord({ brand: acme._id, isActive: false });

      const response = await createClient(app).get('/api/v1/brands');
      expect(response.status).toBe(200);
      expect(response.body.data.map((brand) => brand.name)).toEqual(['Acme', 'Zebra']);

      const acmeRow = response.body.data.find((brand) => brand.id === acme.id);
      expect(acmeRow.productCount).toBe(2);
      expect(acmeRow.activeProductCount).toBe(1);
      expect(acmeRow.nameNormalized).toBeUndefined();

      const zebraRow = response.body.data.find((brand) => brand.id === zebra.id);
      expect(zebraRow.productCount).toBe(0);
    });

    it('supports case-insensitive search', async () => {
      await createBrandRecord({ name: 'NovaTech' });
      await createBrandRecord({ name: 'Aurora' });

      const response = await createClient(app).get('/api/v1/brands?search=NOVA');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe('NovaTech');
    });

    it('treats regex metacharacters in search as literals', async () => {
      await createBrandRecord({ name: 'Aurora' });
      const response = await createClient(app).get('/api/v1/brands?search=.*');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });

    it('gets a brand by id and by slug', async () => {
      const brand = await createBrandRecord({ name: 'Lumen' });
      const client = createClient(app);

      const byId = await client.get(`/api/v1/brands/${brand.id}`);
      expect(byId.status).toBe(200);
      expect(byId.body.data.name).toBe('Lumen');

      const bySlug = await client.get(`/api/v1/brands/${brand.slug}`);
      expect(bySlug.status).toBe(200);
      expect(bySlug.body.data.id).toBe(brand.id);
    });

    it('404s for an unknown brand and 400s for an invalid identifier', async () => {
      const client = createClient(app);
      expect((await client.get('/api/v1/brands/000000000000000000000000')).status).toBe(404);
      expect((await client.get('/api/v1/brands/not-an-id')).status).toBe(404);
    });
  });

  describe('admin mutations', () => {
    it('creates a brand with a generated slug', async () => {
      const response = await adminClient.post('/api/v1/brands', {
        name: 'Kettle & Co',
        description: 'Kitchen appliances',
      });
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({
        name: 'Kettle & Co',
        slug: 'kettle-co',
        description: 'Kitchen appliances',
      });
      expect(await Brand.countDocuments()).toBe(1);
    });

    it('rejects case-insensitive duplicates with 409', async () => {
      await adminClient.post('/api/v1/brands', { name: 'Aurora' });
      const duplicate = await adminClient.post('/api/v1/brands', { name: 'AURORA' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('BRAND_NAME_TAKEN');
      expect(await Brand.countDocuments()).toBe(1);
    });

    it('resolves slug collisions instead of failing', async () => {
      const first = await adminClient.post('/api/v1/brands', { name: 'Aurora' });
      const second = await adminClient.post('/api/v1/brands', { name: 'Aurora!' });
      expect(second.status).toBe(201);
      expect(first.body.data.slug).toBe('aurora');
      expect(second.body.data.slug).toBe('aurora-2');
    });

    it('validates the payload (length, unknown keys)', async () => {
      const tooShort = await adminClient.post('/api/v1/brands', { name: 'A' });
      expect(tooShort.status).toBe(400);
      expect(tooShort.body.error.details[0].path).toBe('body.name');

      const unknownKey = await adminClient.post('/api/v1/brands', {
        name: 'Valid Name',
        nameNormalized: 'sneaky',
      });
      expect(unknownKey.status).toBe(400);
      expect(unknownKey.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('renames a brand, regenerating the slug on a real name change', async () => {
      const created = await adminClient.post('/api/v1/brands', { name: 'Old Name' });
      const id = created.body.data.id;

      const renamed = await adminClient.put(`/api/v1/brands/${id}`, { name: 'New Name' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.slug).toBe('new-name');

      // A description-only edit leaves the slug alone (stable URLs).
      const described = await adminClient.put(`/api/v1/brands/${id}`, { description: 'Updated' });
      expect(described.body.data.slug).toBe('new-name');
    });

    it('rejects a rename that collides case-insensitively', async () => {
      await adminClient.post('/api/v1/brands', { name: 'Aurora' });
      const other = await adminClient.post('/api/v1/brands', { name: 'Lumen' });
      const clash = await adminClient.put(`/api/v1/brands/${other.body.data.id}`, {
        name: 'auRORA',
      });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('BRAND_NAME_TAKEN');
    });

    it('400s an update with no fields and 404s an unknown brand', async () => {
      const created = await adminClient.post('/api/v1/brands', { name: 'Valid' });
      expect((await adminClient.put(`/api/v1/brands/${created.body.data.id}`, {})).status).toBe(
        400,
      );
      expect(
        (await adminClient.put('/api/v1/brands/000000000000000000000000', { name: 'Ghost' }))
          .status,
      ).toBe(404);
    });

    it('rejects invalid ObjectIds before touching the database', async () => {
      const response = await adminClient.put('/api/v1/brands/invalid-id', { name: 'Ghost' });
      expect(response.status).toBe(400);
      expect(response.body.error.details.some((detail) => detail.path === 'params.id')).toBe(true);
    });
  });

  describe('deletion integrity', () => {
    it('deletes an unreferenced brand', async () => {
      const created = await adminClient.post('/api/v1/brands', { name: 'Disposable' });
      const response = await adminClient.del(`/api/v1/brands/${created.body.data.id}`);
      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe('Disposable');
      expect(await Brand.countDocuments()).toBe(0);
    });

    it('refuses to delete a brand referenced by active products', async () => {
      const brand = await createBrandRecord({ name: 'Busy' });
      await createProductRecord({ brand: brand._id, isActive: true });

      const response = await adminClient.del(`/api/v1/brands/${brand.id}`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('BRAND_IN_USE');
      expect(response.body.error.details).toEqual({ activeReferences: 1, inactiveReferences: 0 });
      expect(response.body.message).toMatch(/used by 1 product/i);
      expect(await Brand.countDocuments()).toBe(1);
    });

    it('also refuses when only inactive products reference the brand (no dangling refs)', async () => {
      const brand = await createBrandRecord({ name: 'Dormant' });
      await createProductRecord({ brand: brand._id, isActive: false });

      const response = await adminClient.del(`/api/v1/brands/${brand.id}`);
      expect(response.status).toBe(409);
      expect(response.body.error.details).toEqual({ activeReferences: 0, inactiveReferences: 1 });
    });

    it('404s deleting an unknown brand', async () => {
      expect((await adminClient.del('/api/v1/brands/000000000000000000000000')).status).toBe(404);
    });
  });

  describe('authorisation', () => {
    it('401s an anonymous create and 403s a customer create', async () => {
      const anonymous = await createClient(app).post('/api/v1/brands', { name: 'Nope' });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error.code).toBe('AUTH_REQUIRED');

      await createCustomer({ email: 'brand-customer@test.local' });
      const customerClient = createClient(app);
      await customerClient.login('brand-customer@test.local', 'Cust0mer!Passw0rd');
      const forbidden = await customerClient.post('/api/v1/brands', { name: 'Nope' });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('INSUFFICIENT_ROLE');
      expect(await Brand.countDocuments()).toBe(0);
    });

    it('blocks writes for an admin that must change its password', async () => {
      await createAdmin({ email: 'rotating@test.local', mustChangePassword: true });
      const client = createClient(app);
      await client.login('rotating@test.local', 'Adm1n!Passw0rd');

      const response = await client.post('/api/v1/brands', { name: 'Blocked' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      // Reads still work while the account is flagged.
      expect((await client.get('/api/v1/brands')).status).toBe(200);
      expect(admin.email).toBe('brand-admin@test.local');
    });

    it('requires CSRF for admin writes', async () => {
      const response = await adminClient.agent.post('/api/v1/brands').send({ name: 'No CSRF' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_TOKEN_MISSING');
    });
  });
});
