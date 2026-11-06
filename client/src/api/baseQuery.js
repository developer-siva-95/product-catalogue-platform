import { fetchBaseQuery } from '@reduxjs/toolkit/query';

export const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? '/api/v1';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reads a cookie by name (the CSRF token is deliberately readable by JS). */
export function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

let csrfRequest = null;

/**
 * Ensures a CSRF token cookie exists and returns its value.
 *
 * The server rotates the token on login, so the *cookie* is always the source of
 * truth; this only fetches a token when none is present, or when `force` is set
 * after the server rejected the current one. Concurrent callers share a single
 * in-flight request (no token stampede on a page full of mutations).
 */
export async function ensureCsrfToken({ force = false } = {}) {
  if (!force) {
    const existing = readCookie('csrf_token');
    if (existing) return existing;
  }

  if (!csrfRequest) {
    csrfRequest = fetch(`${API_BASE_URL}/auth/csrf`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => payload?.data?.csrfToken ?? readCookie('csrf_token'))
      .catch(() => null)
      .finally(() => {
        csrfRequest = null;
      });
  }
  return csrfRequest;
}

/** Serialises query params, dropping empty values so the URL stays canonical. */
export function buildQueryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE_URL,
  credentials: 'include',
  prepareHeaders: (headers) => {
    headers.set('Accept', 'application/json');
    return headers;
  },
});

/**
 * `fetchBaseQuery` with the two behaviours this API requires:
 *
 * 1. **CSRF** — every unsafe method sends `X-CSRF-Token` matching the readable
 *    `csrf_token` cookie (signed double submit).
 * 2. **Transparent CSRF recovery** — when the backend answers 403 with a
 *    `CSRF_*` code (token expired/rotated by another tab), the token is refreshed
 *    once and the request retried, instead of surfacing a confusing failure. The
 *    retry is bounded to a single attempt so a genuine CSRF rejection still fails.
 */
export const apiBaseQuery = async (args, api, extraOptions) => {
  const request = typeof args === 'string' ? { url: args } : { ...args };
  const method = (request.method ?? 'GET').toUpperCase();

  const perform = async (includeCsrf, { force = false } = {}) => {
    const headers = { ...(request.headers ?? {}) };
    if (includeCsrf) {
      const token = await ensureCsrfToken({ force });
      if (token) headers['X-CSRF-Token'] = token;
    }
    return rawBaseQuery({ ...request, method, headers }, api, extraOptions);
  };

  const isUnsafe = UNSAFE_METHODS.has(method);
  const result = await perform(isUnsafe);

  const errorCode = result.error?.data?.error?.code;
  if (isUnsafe && result.error?.status === 403 && String(errorCode).startsWith('CSRF_')) {
    // The held token is stale (rotated by another tab or an expired session):
    // ask for a fresh one and replay exactly once.
    return perform(true, { force: true });
  }
  return result;
};

export default apiBaseQuery;
