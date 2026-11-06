import { describe, it, expect } from 'vitest';
import { defineRepository } from '../../src/repositories/repository.js';
import { PRODUCTS_REPOSITORY_METHODS } from '../../src/repositories/products.repository.js';
import { BRANDS_REPOSITORY_METHODS } from '../../src/repositories/brands.repository.js';
import { CATEGORIES_REPOSITORY_METHODS } from '../../src/repositories/categories.repository.js';
import { USERS_REPOSITORY_METHODS } from '../../src/repositories/users.repository.js';

/**
 * The repository contracts are what both providers are written against. If a
 * method is dropped from a contract the two implementations can silently diverge,
 * so the surface is pinned here.
 */
describe('repository contracts', () => {
  const contracts = {
    products: PRODUCTS_REPOSITORY_METHODS,
    brands: BRANDS_REPOSITORY_METHODS,
    categories: CATEGORIES_REPOSITORY_METHODS,
    users: USERS_REPOSITORY_METHODS,
  };

  it.each(Object.entries(contracts))(
    '%s exposes a frozen, non-empty method list',
    (_n, methods) => {
      expect(Array.isArray(methods)).toBe(true);
      expect(methods.length).toBeGreaterThan(0);
      expect(Object.isFrozen(methods)).toBe(true);
      expect(new Set(methods).size).toBe(methods.length);
    },
  );

  it('pins the products surface the MySQL implementation has to match', () => {
    expect([...PRODUCTS_REPOSITORY_METHODS]).toEqual([
      'listStorefront',
      'listAdmin',
      'findById',
      'findAdminById',
      'existsBySlug',
      'existsBySku',
      'allocateSlug',
      'allocateSku',
      'create',
      'replaceFields',
      'updateStock',
      'deleteById',
      'countByTaxonomy',
      'collectReferencedImageFiles',
    ]);
  });

  it('pins the users surface to the D4(a) users-only auth model', () => {
    expect([...USERS_REPOSITORY_METHODS]).toEqual([
      'findByEmail',
      'findById',
      'existsByEmail',
      'create',
      'recordLogin',
      'recordFailedLogin',
      'rotatePassword',
      'hashPassword',
      'verifyPassword',
    ]);
  });

  describe('defineRepository', () => {
    it('returns the implementation when every method is present', () => {
      const implementation = Object.fromEntries(
        PRODUCTS_REPOSITORY_METHODS.map((method) => [method, () => method]),
      );
      expect(defineRepository('products', PRODUCTS_REPOSITORY_METHODS, implementation)).toBe(
        implementation,
      );
    });

    it('names the missing methods when an implementation is incomplete', () => {
      const implementation = { listStorefront: () => {} };
      expect(() =>
        defineRepository('products', PRODUCTS_REPOSITORY_METHODS, implementation),
      ).toThrow(/Repository "products" is missing: listAdmin, findById/);
    });

    it('rejects a non-object implementation', () => {
      expect(() => defineRepository('products', PRODUCTS_REPOSITORY_METHODS, null)).toThrow(
        TypeError,
      );
    });

    it('rejects a method that is present but not a function', () => {
      const implementation = Object.fromEntries(
        PRODUCTS_REPOSITORY_METHODS.map((method) => [method, () => method]),
      );
      implementation.updateStock = 'nope';
      expect(() =>
        defineRepository('products', PRODUCTS_REPOSITORY_METHODS, implementation),
      ).toThrow(/missing: updateStock/);
    });
  });
});
