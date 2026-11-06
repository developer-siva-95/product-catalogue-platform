import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { Category } from '../../src/modules/categories/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createAdmin, createCustomer, createClient } from '../helpers/auth.js';
import { createCategoryRecord, createProductRecord } from '../helpers/factories.js';

describe('categories API', () => {
  let app;
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
    await createAdmin({ email: 'cat-admin@test.local' });
    adminClient = createClient(app);
    await adminClient.login('cat-admin@test.local', 'Adm1n!Passw0rd');
  });

  it('creates, lists and reads a category', async () => {
    const created = await adminClient.post('/api/v1/categories', {
      name: 'Home & Kitchen',
      description: 'Small appliances',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.slug).toBe('home-kitchen');

    const list = await createClient(app).get('/api/v1/categories');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const bySlug = await createClient(app).get('/api/v1/categories/home-kitchen');
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.id).toBe(created.body.data.id);
  });

  it('enforces case-insensitive uniqueness', async () => {
    await adminClient.post('/api/v1/categories', { name: 'Audio' });
    const duplicate = await adminClient.post('/api/v1/categories', { name: 'AUDIO' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CATEGORY_NAME_TAKEN');
  });

  it('validates name length and rejects unknown fields', async () => {
    expect((await adminClient.post('/api/v1/categories', { name: '' })).status).toBe(400);
    expect(
      (await adminClient.post('/api/v1/categories', { name: 'Valid', slug: 'hijack' })).status,
    ).toBe(400);
  });

  it('renames with slug regeneration and conflict detection', async () => {
    const first = await adminClient.post('/api/v1/categories', { name: 'Audio' });
    const second = await adminClient.post('/api/v1/categories', { name: 'Wearables' });

    const renamed = await adminClient.put(`/api/v1/categories/${second.body.data.id}`, {
      name: 'Photo & Video',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.slug).toBe('photo-video');

    const clash = await adminClient.put(`/api/v1/categories/${second.body.data.id}`, {
      name: 'audio',
    });
    expect(clash.status).toBe(409);
    expect(first.body.data.name).toBe('Audio');
  });

  it('blocks deletion while products reference the category', async () => {
    const category = await createCategoryRecord({ name: 'Referenced' });
    await createProductRecord({ category: category._id, isActive: true });

    const blocked = await adminClient.del(`/api/v1/categories/${category.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CATEGORY_IN_USE');
    expect(blocked.body.error.details.activeReferences).toBe(1);
    expect(await Category.countDocuments()).toBe(1);
  });

  it('deletes an unreferenced category', async () => {
    const category = await createCategoryRecord({ name: 'Unused' });
    const deleted = await adminClient.del(`/api/v1/categories/${category.id}`);
    expect(deleted.status).toBe(200);
    expect(await Category.countDocuments()).toBe(0);
  });

  it('restricts writes to admins', async () => {
    await createCustomer({ email: 'cat-customer@test.local' });
    const customerClient = createClient(app);
    await customerClient.login('cat-customer@test.local', 'Cust0mer!Passw0rd');

    const response = await customerClient.post('/api/v1/categories', { name: 'Nope' });
    expect(response.status).toBe(403);
    expect((await createClient(app).post('/api/v1/categories', { name: 'Nope' })).status).toBe(401);
  });

  it('reports product counts per category', async () => {
    const category = await createCategoryRecord({ name: 'Counted' });
    await createProductRecord({ category: category._id });
    await createProductRecord({ category: category._id, isActive: false });

    const list = await createClient(app).get('/api/v1/categories');
    const row = list.body.data.find((item) => item.id === category.id);
    expect(row).toMatchObject({ productCount: 2, activeProductCount: 1 });
  });
});
