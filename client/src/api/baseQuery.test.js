import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBaseQuery, buildQueryString, ensureCsrfToken, readCookie } from './baseQuery.js';
import { clearCookies, jsonResponse, setCookie } from '../test/utils.jsx';

const API = 'http://localhost:3000/api/v1';
const api = { signal: new AbortController().signal, dispatch: vi.fn(), getState: () => ({}) };
const extra = {};

/** `fetchBaseQuery` hands `fetch` a `Request`, not (url, init). */
function firstCall(fetchMock, index = 0) {
  return fetchMock.mock.calls[index][0];
}

describe('readCookie', () => {
  beforeEach(clearCookies);

  it('reads a cookie value', () => {
    setCookie('csrf_token', 'abc123');
    expect(readCookie('csrf_token')).toBe('abc123');
  });

  it('returns null for a missing cookie', () => {
    expect(readCookie('nope')).toBeNull();
  });

  it('decodes URL-encoded cookie values', () => {
    setCookie('csrf_token', encodeURIComponent('a b+c'));
    expect(readCookie('csrf_token')).toBe('a b+c');
  });
});

describe('buildQueryString', () => {
  it('drops empty, null and undefined values', () => {
    expect(buildQueryString({ page: 2, search: '', brand: null, category: undefined })).toBe(
      '?page=2',
    );
  });

  it('returns an empty string when nothing remains', () => {
    expect(buildQueryString({ search: '' })).toBe('');
    expect(buildQueryString()).toBe('');
  });

  it('encodes reserved characters', () => {
    expect(buildQueryString({ search: 'a&b c' })).toBe('?search=a%26b+c');
  });
});

describe('apiBaseQuery CSRF contract', () => {
  let fetchMock;

  beforeEach(() => {
    clearCookies();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies();
  });

  it('does not attach a CSRF header to safe GET requests', async () => {
    setCookie('csrf_token', 'token-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await apiBaseQuery({ url: '/products' }, api, extra);

    expect(result.data).toEqual({ data: [] });
    const request = firstCall(fetchMock);
    expect(request.url).toBe(`${API}/products`);
    expect(request.method).toBe('GET');
    expect(request.headers.get('X-CSRF-Token')).toBeNull();
    expect(request.credentials).toBe('include');
    expect(request.headers.get('Accept')).toBe('application/json');
  });

  it('attaches the readable csrf_token cookie to unsafe methods', async () => {
    setCookie('csrf_token', 'token-1');
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'p1' } }, { status: 201 }));

    await apiBaseQuery({ url: '/admin/products', method: 'POST', body: {} }, api, extra);

    const request = firstCall(fetchMock);
    expect(request.method).toBe('POST');
    expect(request.headers.get('X-CSRF-Token')).toBe('token-1');
  });

  it('fetches a token first when no cookie exists', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { csrfToken: 'fresh-token' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }, { status: 201 }));

    await apiBaseQuery({ url: '/brands', method: 'POST', body: { name: 'Aurora' } }, api, extra);

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/auth/csrf`);
    expect(firstCall(fetchMock, 1).headers.get('X-CSRF-Token')).toBe('fresh-token');
  });

  it('refreshes the token and retries exactly once on a CSRF_* 403', async () => {
    setCookie('csrf_token', 'stale-token');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'CSRF_TOKEN_MISMATCH', message: 'CSRF token mismatch' } },
          { status: 403 },
        ),
      )
      // Forced refresh: the endpoint sets a new csrf_token cookie.
      .mockImplementationOnce(async () => {
        setCookie('csrf_token', 'new-token');
        return jsonResponse({ data: { csrfToken: 'new-token' } });
      })
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'p2' } }, { status: 201 }));

    const result = await apiBaseQuery(
      { url: '/admin/products', method: 'POST', body: {} },
      api,
      extra,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`${API}/auth/csrf`);
    expect(firstCall(fetchMock, 2).headers.get('X-CSRF-Token')).toBe('new-token');
    expect(result.data).toEqual({ data: { id: 'p2' } });
  });

  it('does not retry when the CSRF rejection persists', async () => {
    setCookie('csrf_token', 'stale-token');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'CSRF_TOKEN_INVALID' } }, { status: 403 }),
      )
      .mockImplementationOnce(async () => {
        setCookie('csrf_token', 'still-stale');
        return jsonResponse({ data: { csrfToken: 'still-stale' } });
      })
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'CSRF_TOKEN_INVALID' } }, { status: 403 }),
      );

    const result = await apiBaseQuery({ url: '/admin/products', method: 'DELETE' }, api, extra);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.error.status).toBe(403);
    expect(result.error.data.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('does not retry non-CSRF 403 responses (e.g. INSUFFICIENT_ROLE)', async () => {
    setCookie('csrf_token', 'token-1');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'INSUFFICIENT_ROLE' } }, { status: 403 }),
    );

    const result = await apiBaseQuery({ url: '/admin/products', method: 'POST' }, api, extra);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error.data.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('shares one in-flight token request between concurrent callers', async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({ data: { csrfToken: 'shared' } });
    });

    const [a, b] = await Promise.all([ensureCsrfToken(), ensureCsrfToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe('shared');
    expect(b).toBe('shared');
  });

  it('falls back to the cookie when the token endpoint fails', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
    );

    await expect(ensureCsrfToken()).resolves.toBeNull();
  });
});
