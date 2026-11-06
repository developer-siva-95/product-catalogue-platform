import { describe, expect, it } from 'vitest';
import { computeWindow, reservedHeight, OVERSCAN_ROWS } from './useVirtualGrid.js';

/**
 * The windowing maths is a pure function precisely so it can be verified without a
 * layout engine: jsdom has no geometry, so these are the tests that pin the
 * behaviour, and Chromium (E2E + the DOM-budget audit) confirms it against real
 * layout.
 */

const GRID = { columns: 4, stride: 362, viewportHeight: 800 }; // 1280px laptop, 346px card + 16px gap

describe('computeWindow', () => {
  it('renders nothing for an empty list', () => {
    const window = computeWindow({ ...GRID, itemCount: 0, offset: 0 });
    expect(window.renderedCount).toBe(0);
    expect(window.totalRows).toBe(0);
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe(-1);
  });

  it('renders the top rows plus overscan at the top of the list', () => {
    const window = computeWindow({ ...GRID, itemCount: 240, offset: 0 });

    // Rows fully or partly visible: floor(800 / 362) => 0..2, plus 2 overscan.
    expect(window.startRow).toBe(0);
    expect(window.endRow).toBe(2 + OVERSCAN_ROWS);
    expect(window.startIndex).toBe(0);
    expect(window.endIndex).toBe((2 + OVERSCAN_ROWS + 1) * GRID.columns - 1);
    expect(window.renderedCount).toBeLessThanOrEqual(24);
  });

  it('slides the window with the scroll offset', () => {
    const window = computeWindow({ ...GRID, itemCount: 240, offset: 10 * GRID.stride });

    expect(window.startRow).toBe(10 - OVERSCAN_ROWS);
    expect(window.startIndex).toBe((10 - OVERSCAN_ROWS) * GRID.columns);
    // The rendered row count is the visible band plus overscan on both sides…
    expect(window.endRow - window.startRow + 1).toBe(3 + OVERSCAN_ROWS * 2);
    // …and it does not grow with depth: the same budget 30 rows further down.
    const deeper = computeWindow({ ...GRID, itemCount: 240, offset: 40 * GRID.stride });
    expect(deeper.renderedCount).toBe(window.renderedCount);
  });

  it('never renders past the end of the list', () => {
    const window = computeWindow({ ...GRID, itemCount: 13, offset: 100_000 });

    expect(window.endRow).toBe(window.totalRows - 1);
    expect(window.endIndex).toBe(12);
    expect(window.startRow).toBeLessThanOrEqual(window.endRow);
  });

  it('clamps a negative or non-numeric scroll offset', () => {
    const negative = computeWindow({ ...GRID, itemCount: 240, offset: -500 });
    const junk = computeWindow({ ...GRID, itemCount: 240, offset: Number.NaN });
    expect(negative.startRow).toBe(0);
    expect(junk.startRow).toBe(0);
  });

  it('keeps a focused row in the window when it sits just past the edge', () => {
    const atTop = computeWindow({ ...GRID, itemCount: 240, offset: 0 });
    const focusIndex = (atTop.endRow + 1) * GRID.columns; // first card of the next row
    const withFocus = computeWindow({ ...GRID, itemCount: 240, offset: 0, focusIndex });

    expect(withFocus.endIndex).toBeGreaterThanOrEqual(focusIndex);
    expect(withFocus.renderedCount).toBeGreaterThan(atTop.renderedCount);
  });

  it('does not let a focus left far behind defeat the DOM bound', () => {
    const window = computeWindow({ ...GRID, itemCount: 240, offset: 0, focusIndex: 200 });
    // Focus sits ~50 rows below the window: it is ignored rather than mounted.
    expect(window.endRow).toBe(2 + OVERSCAN_ROWS);
    expect(window.renderedCount).toBeLessThanOrEqual(24);
  });

  it('pins a focused row that is above the window (Shift+Tab)', () => {
    const window = computeWindow({
      ...GRID,
      itemCount: 240,
      offset: 10 * GRID.stride,
      focusIndex: (10 - OVERSCAN_ROWS - 1) * GRID.columns,
    });
    expect(window.startRow).toBe(10 - OVERSCAN_ROWS - 1 - OVERSCAN_ROWS);
  });

  it('slides the window onto a focused row that a resize moved out of view', () => {
    // Focus was taken on card 30 under the 4-column layout; the viewport is then
    // resized to 2 columns, so at the same pixel offset card 30 is far below.
    const window = computeWindow({
      ...GRID,
      itemCount: 240,
      offset: 0,
      focusIndex: 30,
      pinFar: true,
    });

    expect(window.anchored).toBe(true);
    expect(window.startIndex).toBeLessThanOrEqual(30);
    expect(window.endIndex).toBeGreaterThanOrEqual(30);
    // Same row budget as a scroll window: the DOM stays bounded.
    expect(window.renderedCount).toBeLessThanOrEqual(28);
  });

  it('does not anchor while the focused row is still near the window', () => {
    const window = computeWindow({
      ...GRID,
      itemCount: 240,
      offset: 0,
      focusIndex: 4,
      pinFar: true,
    });
    expect(window.anchored).toBe(false);
  });

  it('adapts to a different column count and stride (phone layout)', () => {
    const phone = { columns: 2, stride: 300, viewportHeight: 844 };
    const window = computeWindow({ ...phone, itemCount: 240, offset: 0 });

    // floor(844 / 300) => 0..2 visible rows, plus overscan.
    expect(window.endRow).toBe(2 + OVERSCAN_ROWS);
    expect(window.renderedCount).toBe((window.endRow + 1) * 2);
    // Three columns on a tablet is another stride, same bounded budget.
    const tablet = computeWindow({
      columns: 3,
      stride: 364,
      viewportHeight: 1024,
      itemCount: 240,
      offset: 0,
    });
    expect(tablet.renderedCount).toBeLessThanOrEqual(24);
  });
});

describe('reservedHeight', () => {
  it('drops the trailing row gap', () => {
    expect(reservedHeight({ totalRows: 10, rowHeight: 362, gap: 16 })).toBe(10 * 362 - 16);
  });

  it('reserves nothing for an empty grid', () => {
    expect(reservedHeight({ totalRows: 0, rowHeight: 362, gap: 16 })).toBe(0);
  });
});
