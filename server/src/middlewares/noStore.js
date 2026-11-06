/**
 * `Cache-Control` for dynamic JSON responses.
 *
 * The RTK Query cache is an *in-memory* cache owned by the client and it is
 * revalidated on mount and on mutation. The browser's HTTP cache is a different
 * layer, and on this API it was previously undefined: Express served JSON with an
 * ETag and no explicit policy, which lets a user agent (or any intermediary that
 * applies heuristic freshness) answer a `GET /products/:id` from disk after an
 * admin changed the stock — the exact staleness the manual refresh button cannot
 * reach, because a conditional request can be satisfied with `304 Not Modified`
 * and the old body.
 *
 * `no-store` is the only directive that forbids storing the response at all, which
 * is what a per-request dynamic list/detail needs; `no-cache` + `must-revalidate`
 * are kept for HTTP/1.0-era caches that only understand those, and `Pragma`/
 * `Expires` for proxies that predate `Cache-Control`.
 *
 * Deliberately *not* applied to:
 *  - `/uploads` product images — static, fingerprinted by name, served with
 *    `maxAge: '7d', immutable` on purpose (see app.js); a storefront would be
 *    crippled by re-downloading every thumbnail;
 *  - the API docs / health endpoints — documentation is stable and cacheable,
 *    health is polled by tooling that wants a cheap response.
 */
export function noStoreDynamic(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Express still emits an ETag for these bodies; with `no-store` a compliant cache
  // must not keep the response, and a *conditional* request can therefore never be
  // answered with the old body (RFC 9111 §5.2.2.5). No ETag surgery is needed.
  next();
}

/**
 * Same policy, plus `private`: authenticated admin payloads must never be held by
 * a shared cache even if a future deployment puts a CDN in front of the API.
 */
export function noStorePrivate(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Cookie, Authorization');
  next();
}

export default { noStoreDynamic, noStorePrivate };
