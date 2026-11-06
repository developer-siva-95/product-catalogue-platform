import request from 'supertest';
import { User } from '../../src/modules/auth/model.js';
import { ROLES } from '../../src/constants/appConstants.js';

/** Creates an admin directly in the database (bypasses public registration). */
export async function createAdmin(overrides = {}) {
  const password = overrides.password ?? 'Adm1n!Passw0rd';
  return User.create({
    name: overrides.name ?? 'Test Admin',
    email: overrides.email ?? 'admin@test.local',
    passwordHash: await User.hashPassword(password),
    role: ROLES.ADMIN,
    mustChangePassword: overrides.mustChangePassword ?? false,
    isActive: overrides.isActive ?? true,
  });
}

export async function createCustomer(overrides = {}) {
  const password = overrides.password ?? 'Cust0mer!Passw0rd';
  return User.create({
    name: overrides.name ?? 'Test Customer',
    email: overrides.email ?? 'customer@test.local',
    passwordHash: await User.hashPassword(password),
    role: ROLES.CUSTOMER,
    isActive: overrides.isActive ?? true,
  });
}

/** Parses `set-cookie` headers into a name -> {value, attributes} map. */
export function parseSetCookies(response) {
  const raw = response.headers['set-cookie'] ?? [];
  const cookies = {};
  for (const cookie of raw) {
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    cookies[name] = {
      value,
      attributes: attributes.reduce((acc, attribute) => {
        const [key, attrValue] = attribute.split('=');
        acc[key.toLowerCase()] = attrValue ?? true;
        return acc;
      }, {}),
      raw: cookie,
    };
  }
  return cookies;
}

/**
 * A cookie-aware client that also handles the CSRF handshake, mirroring what the
 * browser SPA does (`GET /auth/csrf` then echo the token in `X-CSRF-Token`).
 */
export function createClient(app) {
  const agent = request.agent(app);
  const client = {
    agent,
    csrfToken: null,

    async fetchCsrf() {
      const response = await agent.get('/api/v1/auth/csrf');
      client.csrfToken = response.body?.data?.csrfToken ?? null;
      return client.csrfToken;
    },

    /** Adds the CSRF header to any request builder. */
    withCsrf(builder) {
      return client.csrfToken ? builder.set('X-CSRF-Token', client.csrfToken) : builder;
    },

    async post(url, body = {}) {
      if (!client.csrfToken) await client.fetchCsrf();
      return client.withCsrf(agent.post(url)).send(body);
    },

    async patch(url, body = {}) {
      if (!client.csrfToken) await client.fetchCsrf();
      return client.withCsrf(agent.patch(url)).send(body);
    },

    async put(url, body = {}) {
      if (!client.csrfToken) await client.fetchCsrf();
      return client.withCsrf(agent.put(url)).send(body);
    },

    async del(url) {
      if (!client.csrfToken) await client.fetchCsrf();
      return client.withCsrf(agent.delete(url));
    },

    async get(url) {
      return agent.get(url);
    },

    /**
     * Returns an unsent supertest builder with the CSRF header applied — needed
     * for multipart uploads where `.field()/.attach()` must be chained before the
     * request is dispatched.
     *
     * Deliberately NOT async: supertest's Test is a thenable, so an async wrapper
     * would resolve to the *response* and the chaining methods would be lost.
     */
    builderFor(method, url) {
      return client.withCsrf(agent[method](url));
    },

    /** Performs a full login handshake. */
    async login(email, password) {
      await client.fetchCsrf();
      const response = await client.post('/api/v1/auth/login', { email, password });
      if (response.body?.data?.csrfToken) client.csrfToken = response.body.data.csrfToken;
      return response;
    },
  };

  return client;
}
