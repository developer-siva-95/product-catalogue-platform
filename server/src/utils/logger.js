/**
 * Minimal structured (JSON-lines) logger.
 *
 * Why not pino/winston: the requirement is structured logs with a request id and
 * test-friendly silence. ~60 lines, zero dependencies, no transport surface to
 * misconfigure. Levels follow syslog severity; output is one JSON object per line
 * so log shippers can parse it without a custom pipeline.
 */

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

function resolveLevel() {
  const fromEnv = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (fromEnv in LEVELS) return fromEnv;
  if (process.env.NODE_ENV === 'test') return 'silent';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

let currentLevel = resolveLevel();

/** Redacts obvious secrets so logs never leak credentials or tokens. */
const REDACT_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'authorization',
  'cookie',
  'csrftoken',
  'jwtsecret',
  'secret',
]);

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function write(level, message, meta = {}) {
  if (currentLevel === 'silent') return;
  if (LEVELS[level] > LEVELS[currentLevel]) return;

  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...redact(meta),
  };

  const line = `${JSON.stringify(entry)}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
  /** Test seam: force a level (or 'silent'). */
  setLevel(level) {
    if (level === 'silent' || level in LEVELS) currentLevel = level;
  },
  getLevel: () => currentLevel,
  /** Creates a child logger that always includes the given bindings (e.g. requestId). */
  child(bindings = {}) {
    return {
      error: (message, meta) => write('error', message, { ...bindings, ...meta }),
      warn: (message, meta) => write('warn', message, { ...bindings, ...meta }),
      info: (message, meta) => write('info', message, { ...bindings, ...meta }),
      debug: (message, meta) => write('debug', message, { ...bindings, ...meta }),
    };
  },
};

export default logger;
