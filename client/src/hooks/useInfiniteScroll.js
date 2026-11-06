import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Infinite scroll built on `IntersectionObserver`.
 *
 * Design notes:
 *  - the observer is created **once per sentinel node**, not per render: the
 *    callbacks are read through refs, so a parent re-render (a keystroke in the
 *    search box, a drawer opening) never tears down and rebuilds it;
 *  - the sentinel is registered with a *callback ref*, so it can appear and
 *    disappear with the product list without the observer being lost (a plain
 *    `useRef` + empty dependency list would attach to `null` on first paint);
 *  - `canLoadMore` is re-read inside the callback, so a stale closure cannot fire
 *    a second request for a page that is already on its way;
 *  - `disconnect()` runs on unmount and whenever the node changes, so no observer
 *    outlives the component;
 *  - the default `rootMargin` is deliberately small (200px): a large margin makes a
 *    tall desktop grid request page 2 before the shopper has scrolled at all, which
 *    defeats the point of incremental loading.
 *
 * @param {{
 *   onLoadMore: () => void,
 *   canLoadMore: boolean,
 *   rootMargin?: string
 * }} options
 * @returns {{ sentinelRef: (node: Element|null) => void, supported: boolean }}
 */
export function useInfiniteScroll({ onLoadMore, canLoadMore, rootMargin = '200px 0px' }) {
  const [sentinelNode, setSentinelNode] = useState(null);
  const [supported] = useState(() => typeof IntersectionObserver === 'function');

  // Refs keep the latest callbacks without re-creating the observer. They are
  // updated after commit (not during render), which is safe here because the
  // observer only ever calls back after paint.
  const onLoadMoreRef = useRef(onLoadMore);
  const canLoadMoreRef = useRef(canLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
    canLoadMoreRef.current = canLoadMore;
  });

  const sentinelRef = useCallback((node) => {
    setSentinelNode(node ?? null);
  }, []);

  useEffect(() => {
    if (!supported || !sentinelNode) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (visible && canLoadMoreRef.current) onLoadMoreRef.current?.();
      },
      { rootMargin },
    );

    observer.observe(sentinelNode);

    return () => observer.disconnect();
  }, [supported, sentinelNode, rootMargin]);

  return { sentinelRef, supported };
}

export default useInfiniteScroll;
