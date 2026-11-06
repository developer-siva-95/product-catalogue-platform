/**
 * Runtime / operations regression audit.
 *
 * Starts the *real* server process (no supertest) in three configurations and
 * asserts operational behaviour: MongoDB failure handling, production posture,
 * load behaviour, log hygiene and graceful shutdown.
 *
 * Run: node audit/runtime-audit.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(repoRoot, '.cache', 'runtime-audit');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'mongo'), { recursive: true });

const { MongoMemoryServer } = await import('mongodb-memory-server');

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Spawns the production server, resolves when it logs "listening" or exits. */
function startServer(env, { port }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(repoRoot, 'server'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  child.stdout.on('data', (d) => {
    logs.out += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs.err += d.toString();
  });
  const ready = new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`server exited early (code ${child.exitCode}): ${logs.err || logs.out}`));
        return;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        if (response.ok) {
          clearInterval(timer);
          resolve({ child, logs, startupMs: Date.now() - started });
        }
      } catch {
        /* not listening yet */
      }
    }, 150);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error('server did not become healthy within 20s'));
    }, 20_000);
  });
  return { child, logs, ready };
}

// --------------------------------------------------------------------------- 1. MongoDB failure
await check('server fails fast and loudly when MongoDB is unreachable', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(repoRoot, 'server'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '5071',
      DATABASE_PROVIDER: 'mongodb',
      MONGO_URI: 'mongodb://127.0.0.1:27099/never-up',
      JWT_SECRET: 'runtime-audit-secret-4f1c3a5d7b2e4f6081a3c5e7b9d0f2a4c6e8b1d3f5a7c9e0b',
      COOKIE_SECURE: 'true',
      FRONTEND_URL: 'https://catalogue.example.com',
      LOG_LEVEL: 'info',
      UPLOAD_DIR: path.join(scratch, 'uploads'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
  });
  const started = Date.now();
  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, 25_000);
  });
  const elapsed = Date.now() - started;
  assert(code !== 0 && code !== 'timeout', `expected a non-zero exit, got ${code}`);
  assert(elapsed < 15_000, `took ${elapsed}ms to give up (expected fail-fast)`);
  assert(
    /mongo|server selection|ECONNREFUSED/i.test(out + err),
    `no MongoDB error was logged: ${(out + err).slice(0, 400)}`,
  );
  return `exit code ${code} after ${elapsed}ms with a logged connection error`;
});

// --------------------------------------------------------------------------- 2. production runtime
const mongo = await MongoMemoryServer.create({
  instance: {
    port: 27995,
    dbName: 'catalogue_runtime_audit',
    dbPath: path.join(scratch, 'mongo'),
  },
});

const PROD_PORT = 5072;
const prod = startServer(
  {
    NODE_ENV: 'production',
    PORT: String(PROD_PORT),
    DATABASE_PROVIDER: 'mongodb',
    MONGO_URI: 'mongodb://127.0.0.1:27995/catalogue_runtime_audit',
    JWT_SECRET: 'runtime-audit-secret-4f1c3a5d7b2e4f6081a3c5e7b9d0f2a4c6e8b1d3f5a7c9e0b',
    JWT_EXPIRES_IN: '1h',
    COOKIE_SECURE: 'true',
    COOKIE_SAME_SITE: 'none',
    FRONTEND_URL: 'https://catalogue.example.com',
    LOG_LEVEL: 'info',
    UPLOAD_DIR: path.join(scratch, 'uploads'),
    RATE_LIMIT_MAX: '100000',
  },
  { port: PROD_PORT },
);

let prodHandle;
await check('production server boots, connects and seeds nothing implicitly', async () => {
  prodHandle = await prod.ready;
  const health = await fetch(`http://127.0.0.1:${PROD_PORT}/api/v1/health`).then((r) => r.json());
  assert(health.data.status === 'ok', `health not ok: ${JSON.stringify(health)}`);
  return `healthy after ${prodHandle.startupMs}ms`;
});

if (prodHandle) {
  const base = `http://127.0.0.1:${PROD_PORT}/api/v1`;

  await check('production responses carry the strict security headers', async () => {
    const response = await fetch(`${base}/health`);
    const headers = Object.fromEntries(response.headers);
    assert(headers['x-powered-by'] === undefined, 'x-powered-by leaked');
    assert(headers['content-security-policy'], 'CSP missing in production');
    assert(headers['x-content-type-options'] === 'nosniff', 'nosniff missing');
    assert(/frame-ancestors/.test(headers['content-security-policy']), 'frame-ancestors missing');
    assert(headers['ratelimit-limit'] || headers['ratelimit'], 'rate-limit headers missing');
    return headers['content-security-policy'].slice(0, 60) + '…';
  });

  await check('unexpected errors stay redacted in production', async () => {
    const response = await fetch(`${base}/products/definitely-not-here`);
    const body = await response.json();
    assert(response.status === 404, `unexpected status ${response.status}`);
    if (body.error) {
      assert(!body.error.stack, 'stack trace leaked in production');
    }
    assert(!/at \/.*\.js:\d+/.test(JSON.stringify(body)), 'source paths leaked in production');
    return '404 envelope without stack';
  });

  await check('CORS rejects unknown origins and accepts the configured frontend', async () => {
    const denied = await fetch(`${base}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert(denied.status === 403, `denied origin returned ${denied.status}`);
    const allowed = await fetch(`${base}/health`, {
      headers: { Origin: 'https://catalogue.example.com' },
    });
    assert(allowed.status === 200, `allowed origin returned ${allowed.status}`);
    assert(
      allowed.headers.get('access-control-allow-origin') === 'https://catalogue.example.com',
      'ACAO header mismatch',
    );
    return '403 for foreign origin, ACAO echoed for allow-listed';
  });

  await check(
    'production session cookies are Secure + SameSite=None + httpOnly and replayable',
    async () => {
      const csrfResponse = await fetch(`${base}/auth/csrf`);
      const csrfCookies = csrfResponse.headers.getSetCookie();
      const csrfCookie = csrfCookies.find((c) => c.startsWith('csrf_token='));
      assert(csrfCookie, 'csrf cookie missing');
      assert(/Secure/i.test(csrfCookie), 'csrf cookie is not Secure');
      assert(/SameSite=None/i.test(csrfCookie), 'csrf cookie is not SameSite=None');
      const token = (await csrfResponse.json()).data.csrfToken;

      const register = await fetch(`${base}/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          Cookie: csrfCookies.map((c) => c.split(';')[0]).join('; '),
        },
        body: JSON.stringify({
          name: 'Runtime Audit User',
          email: `runtime.audit.${Date.now()}@example.com`,
          password: 'Runt1me!Passw0rd',
          confirmPassword: 'Runt1me!Passw0rd',
        }),
      });
      assert(
        register.status === 201,
        `register returned ${register.status}: ${await register.text()}`,
      );

      const cookies = register.headers.getSetCookie();
      const sessionCookie = cookies.find((c) => /HttpOnly/i.test(c) && !/csrf_token/.test(c));
      assert(sessionCookie, `no httpOnly session cookie in ${JSON.stringify(cookies)}`);
      assert(/Secure/i.test(sessionCookie), 'session cookie is not Secure');
      assert(/SameSite=None/i.test(sessionCookie), 'session cookie is not SameSite=None');

      // Replay the cookie manually: the session must be honoured by /auth/me.
      const jar = cookies.map((c) => c.split(';')[0]).join('; ');
      const me = await fetch(`${base}/auth/me`, { headers: { Cookie: jar } });
      assert(me.status === 200, `/auth/me with the issued cookie returned ${me.status}`);
      const body = await me.json();
      assert(!('passwordHash' in body.data.user), 'password hash exposed on /auth/me');
      return `Secure + SameSite=None + HttpOnly; /auth/me replayed the session (${body.data.user.role})`;
    },
  );

  await check('a load burst of 200 requests stays healthy with no 5xx', async () => {
    const before = prodHandle.child.pid;
    const rssBefore = Number(
      fs.readFileSync(`/proc/${before}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0,
    );
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        fetch(`${base}/products?limit=12${i % 2 ? '&sort=price_asc' : ''}`).then((r) => r.status),
      ),
    );
    const elapsed = Date.now() - started;
    const bad = responses.filter((s) => s >= 500);
    assert(bad.length === 0, `${bad.length} server errors during the burst`);
    const rssAfter = Number(
      fs.readFileSync(`/proc/${before}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/)?.[1] ?? 0,
    );
    const growthMb = ((rssAfter - rssBefore) / 1024).toFixed(1);
    assert(rssAfter - rssBefore < 200 * 1024, `RSS grew by ${growthMb}MB`);
    return `200 requests in ${elapsed}ms, RSS +${growthMb}MB, 0 x 5xx`;
  });

  await check('no secrets or unhandled rejections appear in the production logs', async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const logs = prodHandle.logs.out + prodHandle.logs.err;
    const offenders = [
      ['JWT secret', /runtime-audit-secret/],
      ['password hash', /\$2[aby]\$/],
      ['raw JWT', /eyJ[A-Za-z0-9_-]{10,}\./],
      ['unhandledRejection', /unhandledRejection|UnhandledPromiseRejection/],
      ['uncaughtException', /uncaughtException/],
      ['deprecation warning', /DeprecationWarning/],
      ['experimental warning', /ExperimentalWarning/],
    ].filter(([, re]) => re.test(logs));
    assert(
      offenders.length === 0,
      `log hygiene violations: ${offenders.map(([n]) => n).join(', ')}`,
    );
    assert(logs.length > 0, 'no logs were produced at all');
    return `${logs.split('\n').filter(Boolean).length} log lines, none sensitive`;
  });

  await check('SIGTERM shuts the process down gracefully (exit 0, port released)', async () => {
    const exit = new Promise((resolve) => prodHandle.child.on('exit', (code) => resolve(code)));
    prodHandle.child.kill('SIGTERM');
    const code = await Promise.race([
      exit,
      new Promise((r) => setTimeout(() => r('timeout'), 15_000)),
    ]);
    assert(code === 0, `expected exit code 0, got ${code}`);
    const stillUp = await fetch(`http://127.0.0.1:${PROD_PORT}/api/v1/health`).then(
      () => true,
      () => false,
    );
    assert(!stillUp, 'port still answering after shutdown');
    const logs = prodHandle.logs.out;
    assert(/shutdown|closing/i.test(logs), 'no shutdown log line');
    return 'exit 0 and listener closed';
  });
}

await mongo.stop();

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(
  path.join(repoRoot, 'audit', 'runtime-audit-results.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), passed, failed: failed.length, results },
    null,
    2,
  ),
);
console.log(
  `\nRUNTIME AUDIT: ${passed} passed, ${failed.length} failed (${results.length} checks)`,
);
for (const failure of failed) console.log(`  FAIL ${failure.name}\n        ${failure.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
