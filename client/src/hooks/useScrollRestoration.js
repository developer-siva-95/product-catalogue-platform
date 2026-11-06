import { useEffect, useRef } from 'react';

const STORAGE_PREFIX = 'catalogue:scroll:';
/** Room for sub-pixel/rounding differences between save and restore. */
const TOLERANCE_PX = 8;
/** Frames to wait for layout to grow to the restored offset (~250 ms at 60 fps). */
const MAX_RESTORE_FRAMES = 15;
/**
 * How long after mount the offset is treated as "not yet settled".
 *
 * The browser can rewrite the scroll position while the route swaps (and lazy
 * images can change the document height), so offsets observed in this window are
 * never persisted — otherwise a rendering artefact would overwrite the position
 * the shopper actually left behind.
 */
const SETTLE_MS = 400;

function readOffset(key) {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_PREFIX + key);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    // Private-mode/sandboxed storage: restoration is a nicety, never a failure.
    return 0;
  }
}

function writeOffset(key, value) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, String(Math.round(value)));
  } catch {
    /* ignore */
  }
}

/**
 * Remembers and restores the window scroll offset of a listing.
 *
 * Why a hook instead of relying on the browser: the grid is only as tall as the
 * pages that are currently loaded, so history restoration can only ever land where
 * the *previous* document ended — and it fires before the restored pages are in the
 * DOM. The offset is therefore applied only once the requested depth has been
 * rendered, and it never triggers a request of its own.
 *
 * Three details keep it from fighting the browser:
 * 1. `history.scrollRestoration = 'manual'` while a listing is mounted, so the
 *    browser does not jump to its own stale position mid-restore.
 * 2. Offsets observed during the settle window are not persisted, so a transient
 *    scroll position cannot overwrite the remembered one.
 * 3. The offset is re-applied over a few frames: right after a route swap the
 *    document may still be shorter than the remembered offset, and a single
 *    clamped `scrollTo` would silently land short.
 *
 * The key is the filter set (path + query), so appending a page does not re-trigger
 * a restore, while switching filters starts from the top. Pagination is internal
 * state — it is never part of the URL, and therefore never part of this key.
 *
 * @param {string} key storage key (pathname + filter query)
 * @param {{ ready: boolean }} options `ready` once the target page depth is rendered
 */
export function useScrollRestoration(key, { ready }) {
  const restoredForKey = useRef(null);
  const restoring = useRef(false);
  const settled = useRef(false);

  // Own the scroll position while a listing is on screen.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return undefined;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previous ?? 'auto';
    };
  }, []);

  // Persist the offset while the shopper scrolls (rAF-throttled: one write per frame
  // at most, and none at all while the page is idle).
  useEffect(() => {
    let frame = 0;
    const listingPath = key.slice(0, Math.max(key.indexOf('?'), 0)) || '/';

    const handleScroll = () => {
      if (restoring.current) return;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (restoring.current || !settled.current) return;
        // Passive-effect cleanup runs after paint, so the scroll event a *route
        // change* produces (the shorter detail document clamps the offset to 0)
        // can arrive before this listener is removed. The URL has already moved on
        // by then, which is what tells us the listing is no longer what is on
        // screen — never persist that clamped 0 over the shopper's position.
        if (window.location.pathname !== listingPath) return;
        writeOffset(key, window.scrollY);
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [key]);

  // Restore exactly once per key, after the content that makes the offset reachable
  // exists in the DOM.
  useEffect(() => {
    if (!ready) {
      // The target depth is not painted yet: whatever the browser does to the scroll
      // position now is an artefact, not the shopper's position. Block persistence
      // until the listing is actually on screen (with a safety valve in case the
      // result set stays empty).
      settled.current = false;
      const release = window.setTimeout(() => {
        settled.current = true;
      }, SETTLE_MS * 4);
      return () => window.clearTimeout(release);
    }

    if (restoredForKey.current === key) {
      settled.current = true;
      return undefined;
    }

    restoredForKey.current = key;
    settled.current = false;

    let frame = 0;
    let attempts = 0;
    const finish = () => {
      restoring.current = false;
      settled.current = true;
    };

    const step = () => {
      frame = 0;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const offset = readOffset(key);
      if (offset <= 0) return;

      // Layout has not grown to the remembered offset yet (pages still painting,
      // images still reserving space): wait instead of clamping to the bottom.
      if (offset > maxScroll + TOLERANCE_PX) {
        attempts += 1;
        if (attempts > MAX_RESTORE_FRAMES) return; // genuinely unreachable
        frame = window.requestAnimationFrame(step);
        return;
      }

      window.scrollTo(0, offset);
      attempts += 1;
      if (Math.abs(window.scrollY - offset) <= TOLERANCE_PX || attempts > MAX_RESTORE_FRAMES) {
        finish();
        return;
      }
      frame = window.requestAnimationFrame(step);
    };

    restoring.current = readOffset(key) > 0;
    step();

    if (!restoring.current) settled.current = true;
    // A restore that needs no frames must still release the settle guard after the
    // window in which the browser could interfere.
    const settleTimer = window.setTimeout(() => {
      settled.current = true;
      restoring.current = false;
    }, SETTLE_MS);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      finish();
    };
  }, [key, ready]);
}

export default useScrollRestoration;
