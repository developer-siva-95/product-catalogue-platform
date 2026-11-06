import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Multi-column list virtualization (row windowing), hand-rolled.
 *
 * Why row windowing rather than per-item measurement: every card in the
 * storefront grid has the same height at a given container width (the media frame
 * is `aspect-ratio: 4 / 3` and the title is line-clamped to two lines), so a row's
 * height is a function of the viewport alone. Measured at 390/768/1280 px the
 * cards had exactly one distinct height each (288 / 352 / 346 px), so a single
 * measurement per resize is enough — no height cache, no estimation drift, no
 * anchoring correction.
 *
 * The DOM contract:
 *  - the **viewport** element reserves the full height of all rows, so the
 *    document never changes height when rows mount or unmount (this is what keeps
 *    scroll anchoring, the infinite-scroll sentinel and scroll restoration working
 *    unchanged);
 *  - the **grid** element is translated to the first rendered row, so the visible
 *    rows sit exactly where they would in an unvirtualized grid.
 *
 * Columns are read from the existing CSS (`repeat(auto-fill, …)` / the phone
 * override) instead of a JavaScript breakpoint table: CSS stays the single source
 * of truth and no JS breakpoint can drift from it.
 *
 * Accessibility and keyboard traversal:
 *  - the row holding DOM focus is always kept inside the window (plus `overscan`
 *    rows of context), so a focused card is never unmounted — Tab/Shift+Tab
 *    therefore continue through the list instead of dropping to `<body>`;
 *  - each rendered card receives its true 1-based position and the total count via
 *    `aria-posinset` / `aria-setsize`, so assistive technology still announces
 *    "7 of 240" although only part of the list is mounted.
 */

/** Extra rows rendered above and below the visible range. */
export const OVERSCAN_ROWS = 2;
/**
 * How far outside the visible window a focused row is still pulled into the render
 * range. A focused card is normally *inside* the window (it has to be mounted to
 * hold focus), so this only matters when the window moves under a persistent focus
 * — and the cap keeps a stray focus from defeating the bound on DOM size.
 */
const FOCUS_PIN_MAX_ROWS = 2;
/** Fallbacks used before the first measurement (and in environments without layout). */
const FALLBACK_COLUMNS = 2;
const FALLBACK_CARD_HEIGHT = 300;
const FALLBACK_GAP = 16;

/**
 * Pure windowing maths — exported so it can be tested without a layout engine.
 *
 * @param {object} input
 * @param {number} input.itemCount total products
 * @param {number} input.columns columns laid out by CSS (>= 1)
 * @param {number} input.stride row height **including** the row gap, in px
 * @param {number} input.offset scroll offset from the top of the reserved viewport
 * @param {number} input.viewportHeight visible height, in px
 * @param {number} [input.overscan] extra rows above/below
 * @param {number|null} [input.focusIndex] index of the card holding DOM focus
 * @param {boolean} [input.pinFar] keep the focused row mounted even when the scroll
 *   window no longer contains it (used right after a column-count/stride change,
 *   when the reflow moved the focused row somewhere else entirely)
 * @returns {{
 *   startRow: number, endRow: number, startIndex: number, endIndex: number,
 *   totalRows: number, totalHeight: number, renderedCount: number, rowHeight: number,
 *   anchored: boolean
 * }}
 */
export function computeWindow({
  itemCount,
  columns,
  stride,
  offset,
  viewportHeight,
  overscan = OVERSCAN_ROWS,
  focusIndex = null,
  pinFar = false,
}) {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rowHeight = Math.max(1, stride);
  const count = Math.max(0, itemCount);
  const totalRows = Math.ceil(count / cols);

  if (count === 0) {
    return {
      startRow: 0,
      endRow: -1,
      startIndex: 0,
      endIndex: -1,
      totalRows: 0,
      totalHeight: 0,
      renderedCount: 0,
      rowHeight,
    };
  }

  const scrolled = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const visible = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const firstVisibleRow = Math.floor(scrolled / rowHeight);
  const lastVisibleRow = Math.floor((scrolled + visible) / rowHeight);

  let startRow = firstVisibleRow - overscan;
  let endRow = lastVisibleRow + overscan;

  // Focus pinning: the focused row and its context are always rendered, whichever
  // direction the shopper is tabbing through — but only while it is near the
  // window, so a focus left behind by a long scroll cannot blow the DOM budget.
  let anchored = false;
  if (focusIndex != null && focusIndex >= 0 && focusIndex < count) {
    const focusRow = Math.floor(focusIndex / cols);
    const near =
      focusRow >= startRow - FOCUS_PIN_MAX_ROWS && focusRow <= endRow + FOCUS_PIN_MAX_ROWS;

    if (near) {
      startRow = Math.min(startRow, focusRow - overscan);
      endRow = Math.max(endRow, focusRow + overscan);
    } else if (pinFar) {
      // The layout changed under a focused card (a viewport resize switched the
      // column count, so the same pixel offset now points at a different row).
      // Slide the whole window onto the focused row — same row budget, so the DOM
      // stays bounded — and let the hook scroll the page to match.
      const visibleRows = lastVisibleRow - firstVisibleRow + 1;
      const span = Math.max(visibleRows + overscan * 2, 1);
      startRow = Math.max(0, focusRow - overscan);
      endRow = Math.min(totalRows - 1, startRow + span - 1);
      anchored = true;
    }
  }

  startRow = Math.max(0, Math.min(startRow, totalRows - 1));
  endRow = Math.max(startRow, Math.min(endRow, totalRows - 1));

  const startIndex = startRow * cols;
  const endIndex = Math.min(count - 1, (endRow + 1) * cols - 1);

  return {
    startRow,
    endRow,
    startIndex,
    endIndex,
    totalRows,
    // Upper bound (row gaps are inside `stride`); the hook refines it with
    // `reservedHeight`, which knows the gap and can drop the trailing one.
    totalHeight: totalRows * rowHeight,
    renderedCount: endIndex - startIndex + 1,
    rowHeight,
    anchored,
  };
}

/**
 * Height reserved for all rows. Kept as a tiny helper so `computeWindow` stays
 * focused on the window itself.
 *
 * @param {{ totalRows: number, rowHeight: number, gap: number }} geometry
 */
export function reservedHeight({ totalRows, rowHeight, gap }) {
  if (totalRows <= 0) return 0;
  return totalRows * rowHeight - gap;
}

/**
 * Reads the layout CSS decided on: column count, row gap and card height.
 *
 * @param {HTMLElement|null} viewport
 * @returns {{ columns: number, gap: number, cardHeight: number, stride: number }}
 */
function measure(viewport) {
  if (!viewport || typeof window === 'undefined') {
    return fallbackGeometry();
  }

  const grid = viewport.querySelector('.product-grid');
  const card = grid?.querySelector('.product-card');
  if (!grid) return fallbackGeometry();

  const gridStyle = window.getComputedStyle(grid);
  const tracks = (gridStyle.gridTemplateColumns ?? '')
    .split(' ')
    .filter((track) => track && track !== 'none');
  const columns = tracks.length || FALLBACK_COLUMNS;

  const parsedGap = Number.parseFloat(gridStyle.rowGap ?? '');
  const gap = Number.isFinite(parsedGap) ? parsedGap : FALLBACK_GAP;

  const measuredHeight = card ? card.getBoundingClientRect().height : 0;
  const cardHeight = measuredHeight > 0 ? measuredHeight : FALLBACK_CARD_HEIGHT;

  return { columns, gap, cardHeight, stride: cardHeight + gap };
}

function fallbackGeometry() {
  return {
    columns: FALLBACK_COLUMNS,
    gap: FALLBACK_GAP,
    cardHeight: FALLBACK_CARD_HEIGHT,
    stride: FALLBACK_CARD_HEIGHT + FALLBACK_GAP,
  };
}

/**
 * @param {{ itemCount: number, enabled: boolean }} options
 */
export function useVirtualGrid({ itemCount, enabled }) {
  const viewportRef = useRef(null);
  const [geometry, setGeometry] = useState(fallbackGeometry);
  const [offset, setOffset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  /**
   * Focus is pinned together with the geometry it was taken under. When the column
   * count or stride changes (a viewport resize), the pinned row is no longer where
   * the scroll offset says it is — that mismatch is what tells `computeWindow` to
   * slide the window onto the focused row instead of unmounting it.
   */
  const [focusPin, setFocusPin] = useState(null);

  /** Latest measured geometry, readable from event handlers without re-rendering. */
  const geometryRef = useRef(geometry);
  useLayoutEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  const remeasure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setGeometry((previous) => {
      const next = measure(viewport);
      if (
        previous.columns === next.columns &&
        previous.stride === next.stride &&
        previous.gap === next.gap
      ) {
        return previous;
      }
      return next;
    });
  }, []);

  /** Scroll offset measured from the top of the reserved viewport, in px. */
  const syncOffset = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top;
    setOffset((previous) => {
      const next = Math.max(0, -top);
      return Math.abs(previous - next) < 1 ? previous : next;
    });
    setViewportHeight((previous) => {
      const next = window.innerHeight;
      return previous === next ? previous : next;
    });
  }, []);

  // Measure once mounted, then whenever the container or a card changes size
  // (viewport resize, drawer opening, font load, column-count change).
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    remeasure();
    syncOffset();

    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver !== 'function') return undefined;

    const observer = new ResizeObserver(() => {
      remeasure();
      syncOffset();
    });
    observer.observe(viewport);
    const grid = viewport.querySelector('.product-grid');
    const card = viewport.querySelector('.product-card');
    if (grid) observer.observe(grid);
    if (card) observer.observe(card);

    return () => observer.disconnect();
  }, [enabled, remeasure, syncOffset, itemCount]);

  // Window scroll + resize, rAF-throttled: one state update per frame at most.
  useEffect(() => {
    if (!enabled) return undefined;
    let frame = 0;

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncOffset();
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, syncOffset]);

  /**
   * Focus pinning: the card that holds DOM focus is never unmounted, so keyboard
   * traversal continues across window boundaries.
   */
  const handleFocusCapture = useCallback((event) => {
    const card = event.target?.closest?.('[data-index]');
    if (!card) return;
    const index = Number(card.dataset.index);
    if (!Number.isInteger(index)) return;
    setFocusPin((previous) =>
      previous?.index === index && previous.columns === geometryRef.current.columns
        ? previous
        : { index, ...geometryRef.current },
    );
  }, []);

  const handleBlurCapture = useCallback((event) => {
    const next = event.relatedTarget;
    if (next && event.currentTarget?.contains?.(next)) return;
    setFocusPin(null);
  }, []);

  const layoutChanged =
    focusPin != null &&
    (focusPin.columns !== geometry.columns || focusPin.stride !== geometry.stride);

  const window_ = computeWindow({
    itemCount,
    columns: geometry.columns,
    stride: geometry.stride,
    offset,
    viewportHeight,
    focusIndex: focusPin?.index ?? null,
    pinFar: layoutChanged,
  });

  /**
   * A layout change moved the focused card out of the rendered band. The card is
   * still mounted (that is what kept DOM focus alive), so all that is left is to put
   * the scroll position back where the shopper can see it.
   */
  useEffect(() => {
    if (!enabled || !window_.anchored) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rowTop =
      viewport.getBoundingClientRect().top + window.scrollY + window_.startRow * geometry.stride;
    window.scrollTo(0, Math.max(0, rowTop - 8));
  }, [enabled, window_.anchored, window_.startRow, geometry.stride]);

  return {
    viewportRef,
    geometry,
    window: {
      ...window_,
      totalHeight: reservedHeight({
        totalRows: window_.totalRows,
        rowHeight: geometry.stride,
        gap: geometry.gap,
      }),
      stride: geometry.stride,
    },
    handleFocusCapture,
    handleBlurCapture,
  };
}

export default useVirtualGrid;
