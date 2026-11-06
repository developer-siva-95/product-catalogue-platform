import { productsRepository as mongoProducts } from './mongo/products.repository.js';
import { brandsRepository as mongoBrands } from './mongo/brands.repository.js';
import { categoriesRepository as mongoCategories } from './mongo/categories.repository.js';
import { usersRepository as mongoUsers } from './mongo/users.repository.js';
import { productsRepository as mysqlProducts } from './mysql/products.repository.js';
import { brandsRepository as mysqlBrands } from './mysql/brands.repository.js';
import { categoriesRepository as mysqlCategories } from './mysql/categories.repository.js';
import { usersRepository as mysqlUsers } from './mysql/users.repository.js';
import { defineRepository } from './repository.js';
import { PRODUCTS_REPOSITORY_METHODS } from './products.repository.js';
import { BRANDS_REPOSITORY_METHODS } from './brands.repository.js';
import { CATEGORIES_REPOSITORY_METHODS } from './categories.repository.js';
import { USERS_REPOSITORY_METHODS } from './users.repository.js';

/**
 * Repository registry.
 *
 * Services get their storage through `getRepositories()`, so swapping the provider
 * is a configuration change, never a code change:
 *
 *   DATABASE_PROVIDER=mongodb  → repositories/mongo/*
 *   DATABASE_PROVIDER=mysql    → repositories/mysql/*
 *
 * `configureRepositories()` is called by the database bootstrap once the provider
 * is known and its connection is established; `defineRepository()` validates each
 * implementation against its contract so a wiring mistake fails fast at startup.
 */

const PROVIDERS = new Map();

/** Every implementation is validated against its contract at import time. */
function defineRepositorySet(set) {
  return Object.freeze({
    products: defineRepository('products', PRODUCTS_REPOSITORY_METHODS, set.products),
    brands: defineRepository('brands', BRANDS_REPOSITORY_METHODS, set.brands),
    categories: defineRepository('categories', CATEGORIES_REPOSITORY_METHODS, set.categories),
    users: defineRepository('users', USERS_REPOSITORY_METHODS, set.users),
  });
}

PROVIDERS.set(
  'mongodb',
  defineRepositorySet({
    products: mongoProducts,
    brands: mongoBrands,
    categories: mongoCategories,
    users: mongoUsers,
  }),
);

PROVIDERS.set(
  'mysql',
  defineRepositorySet({
    products: mysqlProducts,
    brands: mysqlBrands,
    categories: mysqlCategories,
    users: mysqlUsers,
  }),
);

let active = null;
let activeProvider = null;

/**
 * Registers an implementation set for a provider name.
 * @param {string} provider
 * @param {{ products: object, brands: object, categories: object, users: object }} repositories
 */
export function registerRepositories(provider, repositories) {
  PROVIDERS.set(provider, repositories);
}

/**
 * Selects the active provider.
 *
 * Fails loudly when the provider is unknown rather than falling back to MongoDB,
 * because a silent fallback would serve data from the wrong database.
 *
 * @param {string} provider
 */
export function configureRepositories(provider) {
  const repositories = PROVIDERS.get(provider);
  if (!repositories) {
    throw new Error(
      `Unknown DATABASE_PROVIDER "${provider}". Supported: ${[...PROVIDERS.keys()].join(', ')}`,
    );
  }
  active = repositories;
  activeProvider = provider;
  return repositories;
}

/** The repositories of the configured provider (MongoDB until configured). */
export function getRepositories() {
  return active ?? PROVIDERS.get('mongodb');
}

/**
 * Name of the provider the registry is bound to.
 *
 * Reports the *bound* provider rather than `env.DATABASE_PROVIDER`, so tooling and
 * tests that bind a provider explicitly (the seed suite runs against both in one
 * process) describe what actually wrote the data.
 *
 * @returns {string|null}
 */
export function getActiveProvider() {
  return activeProvider;
}

/** Provider names that currently have an implementation. */
export function availableProviders() {
  return [...PROVIDERS.keys()];
}

export default {
  getRepositories,
  configureRepositories,
  registerRepositories,
  availableProviders,
  getActiveProvider,
};
