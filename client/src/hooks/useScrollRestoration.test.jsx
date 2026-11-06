import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScrollRestoration } from './useScrollRestoration.js';

/**
 * Scroll restoration is pure UI state: it must never ask the server for anything,
 * must not fight the browser, and must never persist a position that a route change
 * produced on its way out.
 */

const KEY = '/?';
const STORAGE_KEY = 'catalogue:scroll:/?';

const scrollY = () => window.scrollY;

function stubGeometry({ scrollHeight = 3000, innerHeight = 768 } = {}) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
}

const flushFrames = async (frames = 6) => {
  for (let index = 0; index < frames; index += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
};

describe('useScrollRestoration', () => {
  let scrollTo;

  beforeEach(() => {
    window.sessionStorage.clear();
    stubGeometry();
    scrollTo = vi.fn((_x, y) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    });
    vi.stubGlobal('scrollTo', scrollTo);
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it('does nothing when there is no saved offset', async () => {
    renderHook(() => useScrollRestoration(KEY, { ready: true }));
    await flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('restores the saved offset once the listing is ready', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '900');

    const { rerender } = renderHook(({ ready }) => useScrollRestoration(KEY, { ready }), {
      initialProps: { ready: false },
    });
    // Not painted yet: no jump.
    await flushFrames(3);
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ ready: true });
    await flushFrames(3);
    expect(scrollTo).toHaveBeenCalledWith(0, 900);
  });

  it('does not jump to an offset the shorter list cannot reach', async () => {
    stubGeometry({ scrollHeight: 400 });
    window.sessionStorage.setItem(STORAGE_KEY, '900');

    renderHook(() => useScrollRestoration(KEY, { ready: true }));
    await flushFrames(10);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('never overwrites the saved offset with a position produced while leaving', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '900');
    renderHook(() => useScrollRestoration(KEY, { ready: true }));
    await flushFrames();

    // The route changes and the (shorter) detail document clamps the offset to 0.
    // The listener is still attached for a frame, but the URL has moved on.
    window.history.pushState({}, '', '/product/abc');
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    await flushFrames();

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('900');
    expect(scrollY()).toBe(900);
  });

  it('persists the offset the shopper scrolls to on the listing itself', async () => {
    renderHook(() => useScrollRestoration(KEY, { ready: true }));
    await flushFrames(2);

    Object.defineProperty(window, 'scrollY', { value: 420, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    await flushFrames(2);

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('420');
  });
});
