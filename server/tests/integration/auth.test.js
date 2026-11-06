import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import env from '../../src/config/env.js';
import { User } from '../../src/modules/auth/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { authenticate, authorize, enforcePasswordRotation } from '../../src/middlewares/auth.js';
import { COOKIE_NAMES, ROLES } from '../../src/constants/appConstants.js';
import { generateCsrfToken } from '../../src/middlewares/csrf.js';
import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { connectTestDB, disconnectTestDB, clearDatabase } from '../helpers/db.js';
import { createAdmin, createCustomer, createClient, parseSetCookies } from '../helpers/auth.js';

describe('authentication & authorisation', () => {
  let app;

  beforeAll(async () => {
    await connectTestDB();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
    resetAllRateLimits();
  });

  describe('CSRF handshake', () => {
    it('issues a signed, readable CSRF cookie and echoes the token', async () => {
      const response = await request(app).get('/api/v1/auth/csrf');
      expect(response.status).toBe(200);

      const cookies = parseSetCookies(response);
      expect(cookies[COOKIE_NAMES.CSRF_TOKEN]).toBeDefined();
      // Readable by JS (that is the whole point of double submit) but signed.
      expect(cookies[COOKIE_NAMES.CSRF_TOKEN].attributes.httponly).toBeUndefined();
      expect(response.body.data.csrfToken).toBe(cookies[COOKIE_NAMES.CSRF_TOKEN].value);
      expect(response.body.data.csrfToken.split('.')).toHaveLength(2);
    });

    it('rejects an unsafe request with no CSRF token at all', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'a@b.com', password: 'whatever' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_TOKEN_MISSING');
    });

    it('rejects a header token that does not match the cookie', async () => {
      const client = createClient(app);
      await client.fetchCsrf();
      const response = await client.agent
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', generateCsrfToken())
        .send({ email: 'a@b.com', password: 'whatever' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_TOKEN_MISMATCH');
    });

    it('rejects a tampered token (valid shape, broken signature)', async () => {
      // A cookie-planting attacker can make cookie === header, so the signature is
      // what has to stop them. Send both from a cookie-less client.
      const nonce = 'attacker-nonce-with-sufficient-length-12345678';
      const forged = `${nonce}.${Buffer.from('forged-signature').toString('base64url')}`;

      const response = await request(app)
        .post('/api/v1/auth/login')
        .set('Cookie', `${COOKIE_NAMES.CSRF_TOKEN}=${forged}`)
        .set('X-CSRF-Token', forged)
        .send({ email: 'a@b.com', password: 'whatever' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects a cross-origin unsafe request before CSRF is even evaluated', async () => {
      const client = createClient(app);
      await client.fetchCsrf();
      const response = await client.agent
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', client.csrfToken)
        .set('Origin', 'https://evil.example')
        .send({ email: 'a@b.com', password: 'whatever' });
      // CORS is the origin gate and runs first; the CSRF token alone is not enough.
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CORS_ORIGIN_DENIED');
    });

    it('exempts Bearer-token clients (no ambient cookie authority)', async () => {
      await createAdmin({ email: 'bearer@test.local', password: 'Adm1n!Passw0rd' });
      const login = await request(app)
        .post('/api/v1/auth/login')
        .set('X-CSRF-Token', generateCsrfToken())
        .set('Cookie', `${COOKIE_NAMES.CSRF_TOKEN}=${generateCsrfToken()}`)
        .send({ email: 'bearer@test.local', password: 'Adm1n!Passw0rd' });
      // Without a matching pair this fails; proves CSRF is enforced for cookies.
      expect(login.status).toBe(403);

      const admin = await createAdmin({ email: 'bearer2@test.local' });
      const token = jwt.sign({ sub: admin.id, role: admin.role, ver: 0 }, env.JWT_SECRET, {
        expiresIn: '1h',
        issuer: 'catalogue-api',
        audience: 'catalogue-web',
      });
      const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe('bearer2@test.local');
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await createAdmin({ email: 'admin@test.local', password: 'Adm1n!Passw0rd' });
    });

    it('signs in, issues an httpOnly cookie and returns a safe user payload', async () => {
      const client = createClient(app);
      const response = await client.login('admin@test.local', 'Adm1n!Passw0rd');

      expect(response.status).toBe(200);
      expect(response.body.data.user).toMatchObject({
        email: 'admin@test.local',
        role: ROLES.ADMIN,
      });
      expect(response.body.data.user).not.toHaveProperty('passwordHash');
      expect(response.body.data.user).not.toHaveProperty('_id');
      expect(response.body.data.expiresInMs).toBeGreaterThan(0);

      const cookies = parseSetCookies(response);
      expect(cookies[COOKIE_NAMES.ACCESS_TOKEN].attributes.httponly).toBe(true);
      expect(cookies[COOKIE_NAMES.ACCESS_TOKEN].attributes.samesite).toBe('Lax');
      expect(cookies[COOKIE_NAMES.ACCESS_TOKEN].attributes.path).toBe('/');
      // A fresh CSRF token is rotated on login.
      expect(response.body.data.csrfToken).toBeDefined();
    });

    it('accepts a case-insensitive email', async () => {
      const client = createClient(app);
      const response = await client.login('ADMIN@TEST.LOCAL', 'Adm1n!Passw0rd');
      expect(response.status).toBe(200);
      expect(response.body.data.user.email).toBe('admin@test.local');
    });

    it('returns the same generic 401 for a wrong password and an unknown email', async () => {
      const client = createClient(app);
      const wrongPassword = await client.login('admin@test.local', 'Wrong!Passw0rd');
      const unknownEmail = await client.login('ghost@test.local', 'Wrong!Passw0rd');

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.message).toBe('Invalid email or password');
      expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses sign-in for a deactivated account with the same generic error', async () => {
      await User.updateOne({ email: 'admin@test.local' }, { $set: { isActive: false } });
      const client = createClient(app);
      const response = await client.login('admin@test.local', 'Adm1n!Passw0rd');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('validates the payload shape (Zod) before touching the database', async () => {
      const client = createClient(app);
      const response = await client.post('/api/v1/auth/login', { email: 'not-an-email' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      const paths = response.body.error.details.map((detail) => detail.path);
      expect(paths).toContain('body.email');
      expect(paths).toContain('body.password');
    });

    it('rate limits repeated failed attempts from one IP', async () => {
      const previous = process.env.LOGIN_RATE_LIMIT_MAX;
      process.env.LOGIN_RATE_LIMIT_MAX = '3';
      resetAllRateLimits();
      try {
        const client = createClient(app);
        const statuses = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const response = await client.post('/api/v1/auth/login', {
            email: 'rate@test.local',
            password: 'Wrong!Passw0rd',
          });
          statuses.push(response.status);
        }
        // The first three are ordinary credential failures; the fourth hits the cap.
        expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
        expect(statuses[3]).toBe(429);
        expect(statuses[4]).toBe(429);
      } finally {
        process.env.LOGIN_RATE_LIMIT_MAX = previous;
        resetAllRateLimits();
      }
    });

    it('locks the account after five failed attempts, even for the right password', async () => {
      // Isolate from the IP limiter so this asserts the account-level guard.
      const previous = process.env.LOGIN_RATE_LIMIT_MAX;
      process.env.LOGIN_RATE_LIMIT_MAX = '1000';
      try {
        const client = createClient(app);
        await client.fetchCsrf();

        let lastResponse;
        for (let attempt = 0; attempt < User.MAX_LOGIN_ATTEMPTS; attempt += 1) {
          lastResponse = await client.post('/api/v1/auth/login', {
            email: 'admin@test.local',
            password: 'Wrong!Passw0rd',
          });
        }
        expect(lastResponse.status).toBe(429);
        expect(lastResponse.body.error.code).toBe('ACCOUNT_LOCKED');
        expect(lastResponse.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

        const lockedAttempt = await client.post('/api/v1/auth/login', {
          email: 'admin@test.local',
          password: 'Adm1n!Passw0rd',
        });
        expect(lockedAttempt.status).toBe(429);
        expect(lockedAttempt.body.error.code).toBe('ACCOUNT_LOCKED');
      } finally {
        process.env.LOGIN_RATE_LIMIT_MAX = previous;
      }
    });
  });

  describe('session inspection, logout and token integrity', () => {
    it('GET /auth/me requires a session', async () => {
      const response = await request(app).get('/api/v1/auth/me');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('GET /auth/me returns the live user for a valid cookie', async () => {
      await createAdmin({ email: 'me@test.local' });
      const client = createClient(app);
      await client.login('me@test.local', 'Adm1n!Passw0rd');

      const response = await client.get('/api/v1/auth/me');
      expect(response.status).toBe(200);
      expect(response.body.data.user.email).toBe('me@test.local');
      expect(response.body.data.user.role).toBe(ROLES.ADMIN);
    });

    it('rejects a token with a forged signature, wrong audience or wrong issuer', async () => {
      const admin = await createAdmin({ email: 'tokens@test.local' });

      const signature = jwt.sign(
        { sub: admin.id, role: 'admin', ver: 0 },
        'a-different-secret-with-enough-length-1234',
        {
          expiresIn: '1h',
          issuer: 'catalogue-api',
          audience: 'catalogue-web',
        },
      );
      const audience = jwt.sign({ sub: admin.id, role: 'admin', ver: 0 }, env.JWT_SECRET, {
        expiresIn: '1h',
        issuer: 'catalogue-api',
        audience: 'another-app',
      });
      const issuer = jwt.sign({ sub: admin.id, role: 'admin', ver: 0 }, env.JWT_SECRET, {
        expiresIn: '1h',
        issuer: 'somebody-else',
        audience: 'catalogue-web',
      });

      for (const token of [signature, audience, issuer]) {
        const response = await request(app)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`);
        expect(response.status).toBe(401);
      }
    });

    it('rejects an expired token with TOKEN_EXPIRED', async () => {
      const admin = await createAdmin({ email: 'expired@test.local' });
      const expired = jwt.sign({ sub: admin.id, role: 'admin', ver: 0 }, env.JWT_SECRET, {
        expiresIn: '-1s',
        issuer: 'catalogue-api',
        audience: 'catalogue-web',
      });
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expired}`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects a token issued before a password change (tokenVersion bump)', async () => {
      const admin = await createAdmin({ email: 'revoke@test.local' });
      const token = jwt.sign(
        { sub: admin.id, role: 'admin', ver: admin.tokenVersion },
        env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'catalogue-api', audience: 'catalogue-web' },
      );
      const before = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(before.status).toBe(200);

      await User.updateOne({ _id: admin._id }, { $inc: { tokenVersion: 1 } });

      const after = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('SESSION_REVOKED');
    });

    it('logout clears both cookies and ends the session', async () => {
      await createAdmin({ email: 'logout@test.local' });
      const client = createClient(app);
      await client.login('logout@test.local', 'Adm1n!Passw0rd');

      const logout = await client.post('/api/v1/auth/logout');
      expect(logout.status).toBe(200);

      const cookies = parseSetCookies(logout);
      expect(cookies[COOKIE_NAMES.ACCESS_TOKEN].value).toBe('');
      expect(cookies[COOKIE_NAMES.ACCESS_TOKEN].attributes.expires).toBeDefined();

      const me = await client.get('/api/v1/auth/me');
      expect(me.status).toBe(401);
    });
  });

  describe('registration and privilege escalation', () => {
    it('creates a customer account and starts a session', async () => {
      const client = createClient(app);
      const response = await client.post('/api/v1/auth/register', {
        name: 'New Customer',
        email: 'new@test.local',
        password: 'Str0ng!Passw0rd',
        confirmPassword: 'Str0ng!Passw0rd',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.user.role).toBe(ROLES.CUSTOMER);
      expect(response.body.data.user.mustChangePassword).toBe(false);

      const stored = await User.findOne({ email: 'new@test.local' }).select('+passwordHash');
      expect(stored.role).toBe(ROLES.CUSTOMER);
      expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('refuses to let a public caller choose the admin role', async () => {
      const client = createClient(app);
      const response = await client.post('/api/v1/auth/register', {
        name: 'Sneaky Admin',
        email: 'sneaky@test.local',
        password: 'Str0ng!Passw0rd',
        confirmPassword: 'Str0ng!Passw0rd',
        role: 'admin',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(await User.findOne({ email: 'sneaky@test.local' })).toBeNull();
    });

    it('rejects a duplicate email', async () => {
      await createCustomer({ email: 'taken@test.local' });
      const client = createClient(app);
      const response = await client.post('/api/v1/auth/register', {
        name: 'Another',
        email: 'TAKEN@test.local',
        password: 'Str0ng!Passw0rd',
        confirmPassword: 'Str0ng!Passw0rd',
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EMAIL_IN_USE');
    });

    it('enforces the password policy and confirmation match', async () => {
      const client = createClient(app);
      const weak = await client.post('/api/v1/auth/register', {
        name: 'Weak',
        email: 'weak@test.local',
        password: 'password',
        confirmPassword: 'password',
      });
      expect(weak.status).toBe(400);
      const messages = weak.body.error.details.map((detail) => detail.message).join(' ');
      expect(messages).toMatch(/uppercase letter/i);

      const mismatch = await client.post('/api/v1/auth/register', {
        name: 'Mismatch',
        email: 'mismatch@test.local',
        password: 'Str0ng!Passw0rd',
        confirmPassword: 'Different!Passw0rd',
      });
      expect(mismatch.status).toBe(400);
      expect(
        mismatch.body.error.details.some((detail) => detail.path === 'body.confirmPassword'),
      ).toBe(true);
    });
  });

  describe('password change', () => {
    it('rejects an incorrect current password', async () => {
      await createAdmin({ email: 'change@test.local' });
      const client = createClient(app);
      await client.login('change@test.local', 'Adm1n!Passw0rd');

      const response = await client.post('/api/v1/auth/change-password', {
        currentPassword: 'Wrong!Passw0rd',
        newPassword: 'N3w!Passw0rd',
        confirmPassword: 'N3w!Passw0rd',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURRENT_PASSWORD_INVALID');
    });

    it('rejects reusing the same password', async () => {
      await createAdmin({ email: 'reuse@test.local' });
      const client = createClient(app);
      await client.login('reuse@test.local', 'Adm1n!Passw0rd');

      const response = await client.post('/api/v1/auth/change-password', {
        currentPassword: 'Adm1n!Passw0rd',
        newPassword: 'Adm1n!Passw0rd',
        confirmPassword: 'Adm1n!Passw0rd',
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('changes the password, clears mustChangePassword and revokes old sessions', async () => {
      const admin = await createAdmin({ email: 'rotate@test.local', mustChangePassword: true });
      const client = createClient(app);
      await client.login('rotate@test.local', 'Adm1n!Passw0rd');

      const response = await client.post('/api/v1/auth/change-password', {
        currentPassword: 'Adm1n!Passw0rd',
        newPassword: 'N3w!Passw0rd',
        confirmPassword: 'N3w!Passw0rd',
      });

      expect(response.status).toBe(200);
      expect(response.body.data.user.mustChangePassword).toBe(false);

      const reloaded = await User.findById(admin._id).select('+passwordHash');
      expect(reloaded.mustChangePassword).toBe(false);
      expect(reloaded.tokenVersion).toBe(1);
      expect(reloaded.passwordChangedAt).toBeInstanceOf(Date);
      await expect(reloaded.comparePassword('N3w!Passw0rd')).resolves.toBe(true);

      // The client received fresh cookies, so it stays signed in...
      const me = await client.get('/api/v1/auth/me');
      expect(me.status).toBe(200);

      // ...while the token captured before the change is now revoked.
      const staleToken = jwt.sign({ sub: admin.id, role: 'admin', ver: 0 }, env.JWT_SECRET, {
        expiresIn: '1h',
        issuer: 'catalogue-api',
        audience: 'catalogue-web',
      });
      const stale = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${staleToken}`);
      expect(stale.status).toBe(401);
      expect(stale.body.error.code).toBe('SESSION_REVOKED');
    });

    it('requires authentication to change a password', async () => {
      const client = createClient(app);
      const response = await client.post('/api/v1/auth/change-password', {
        currentPassword: 'whatever',
        newPassword: 'N3w!Passw0rd',
        confirmPassword: 'N3w!Passw0rd',
      });
      expect(response.status).toBe(401);
    });
  });

  describe('authorisation (RBAC) and forced password rotation', () => {
    function buildGatedApp() {
      const gated = express();
      gated.use(express.json());
      gated.get('/admin-only', authenticate, authorize(ROLES.ADMIN), (req, res) =>
        res.json({ success: true, data: { email: req.user.email } }),
      );
      gated.post(
        '/admin-write',
        authenticate,
        authorize(ROLES.ADMIN),
        enforcePasswordRotation,
        (req, res) => res.json({ success: true }),
      );
      gated.use(errorHandler);
      return gated;
    }

    function bearerFor(user) {
      return jwt.sign({ sub: user.id, role: user.role, ver: user.tokenVersion }, env.JWT_SECRET, {
        expiresIn: '1h',
        issuer: 'catalogue-api',
        audience: 'catalogue-web',
      });
    }

    it('401s without a token, 403s for a customer, 200s for an admin', async () => {
      const gated = buildGatedApp();
      const admin = await createAdmin({ email: 'rbac-admin@test.local' });
      const customer = await createCustomer({ email: 'rbac-customer@test.local' });

      expect((await request(gated).get('/admin-only')).status).toBe(401);
      expect(
        (
          await request(gated)
            .get('/admin-only')
            .set('Authorization', `Bearer ${bearerFor(customer)}`)
        ).status,
      ).toBe(403);
      const ok = await request(gated)
        .get('/admin-only')
        .set('Authorization', `Bearer ${bearerFor(admin)}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.email).toBe('rbac-admin@test.local');
    });

    it('returns INSUFFICIENT_ROLE for a customer', async () => {
      const gated = buildGatedApp();
      const customer = await createCustomer({ email: 'rbac-detail@test.local' });
      const response = await request(gated)
        .get('/admin-only')
        .set('Authorization', `Bearer ${bearerFor(customer)}`);
      expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('blocks privileged writes until a flagged account rotates its password', async () => {
      const gated = buildGatedApp();
      const flagged = await createAdmin({ email: 'flagged@test.local', mustChangePassword: true });

      const blocked = await request(gated)
        .post('/admin-write')
        .set('Authorization', `Bearer ${bearerFor(flagged)}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      await User.updateOne({ _id: flagged._id }, { $set: { mustChangePassword: false } });
      const reloaded = await User.findById(flagged._id);
      const allowed = await request(gated)
        .post('/admin-write')
        .set('Authorization', `Bearer ${bearerFor(reloaded)}`);
      expect(allowed.status).toBe(200);
    });

    it('treats a role change as immediate (role is read from the database, not the token)', async () => {
      const gated = buildGatedApp();
      const admin = await createAdmin({ email: 'demote@test.local' });
      const token = bearerFor(admin);

      expect(
        (await request(gated).get('/admin-only').set('Authorization', `Bearer ${token}`)).status,
      ).toBe(200);

      await User.updateOne({ _id: admin._id }, { $set: { role: ROLES.CUSTOMER } });
      const demoted = await request(gated)
        .get('/admin-only')
        .set('Authorization', `Bearer ${token}`);
      expect(demoted.status).toBe(403);
    });
  });
});
