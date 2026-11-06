import { describe, it, expect, afterEach } from 'vitest';
import {
  availableProviders,
  configureRepositories,
  getRepositories,
  registerRepositories,
} from '../../src/repositories/index.js';
import { PRODUCTS_REPOSITORY_METHODS } from '../../src/repositories/products.repository.js';
import { BRANDS_REPOSITORY_METHODS } from '../../src/repositories/brands.repository.js';
import { CATEGORIES_REPOSITORY_METHODS } from '../../src/repositories/categories.repository.js';
import { USERS_REPOSITORY_METHODS } from '../../src/repositories/users.repository.js';

/**
 * The registry is the seam that lets `DATABASE_PROVIDER` swap storage without a
 * code change. It must fail loudly on an unknown provider (a silent fallback would
 * serve data from the wrong database) and it must only ever hand out complete
 * implementations.
 */
describe('repository registry', () => {
  afterEach(() => {
    configureRepositories('mongodb');
  });

  it('defaults to the MongoDB provider', () => {
    expect(availableProviders()).toContain('mongodb');
    expect(getRepositories().products).toBeDefined();
  });

  it('exposes all four domains', () => {
    const repositories = getRepositories();
    expect(Object.keys(repositories).sort()).toEqual(['brands', 'categories', 'products', 'users']);
  });

  it.each([
    ['products', PRODUCTS_REPOSITORY_METHODS],
    ['brands', BRANDS_REPOSITORY_METHODS],
    ['categories', CATEGORIES_REPOSITORY_METHODS],
    ['users', USERS_REPOSITORY_METHODS],
  ])('the MongoDB %s implementation satisfies its contract', (domain, methods) => {
    const repository = getRepositories()[domain];
    for (const method of methods) {
      expect(typeof repository[method], `${domain}.${method}`).toBe('function');
    }
  });

  it('refuses an unknown provider instead of falling back', () => {
    expect(() => configureRepositories('sqlite')).toThrow(/Unknown DATABASE_PROVIDER "sqlite"/);
  });

  it('accepts a registered provider', () => {
    const fake = Object.fromEntries(
      ['products', 'brands', 'categories', 'users'].map((domain) => [domain, { fake: domain }]),
    );
    registerRepositories('fake', fake);
    expect(configureRepositories('fake')).toBe(fake);
    expect(getRepositories().products.fake).toBe('products');
  });

  it('keeps the registry frozen so a provider set cannot be mutated at runtime', () => {
    expect(Object.isFrozen(getRepositories())).toBe(true);
  });
});
