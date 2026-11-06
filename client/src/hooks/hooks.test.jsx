import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue.js';
import { useUnsavedChangesWarning } from './useUnsavedChangesWarning.js';
import { useDocumentTitle } from './useDocumentTitle.js';
import { PAGINATION_PARAM, stripPagination } from './useListingDepth.js';

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 100));
    expect(result.current).toBe('a');
  });

  it('only publishes the value after the delay', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
        initialProps: { value: 'a' },
      });

      rerender({ value: 'ab' });
      expect(result.current).toBe('a');

      act(() => vi.advanceTimersByTime(199));
      expect(result.current).toBe('a');

      act(() => vi.advanceTimersByTime(1));
      expect(result.current).toBe('ab');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the timer on every change (no intermediate values)', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
        initialProps: { value: '' },
      });

      rerender({ value: 'l' });
      act(() => vi.advanceTimersByTime(150));
      rerender({ value: 'la' });
      act(() => vi.advanceTimersByTime(150));
      expect(result.current).toBe('');

      act(() => vi.advanceTimersByTime(50));
      expect(result.current).toBe('la');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies immediately when the delay is zero or negative', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 0), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    expect(result.current).toBe('b');
  });

  it('cancels the pending update on unmount', () => {
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = renderHook(() => useDebouncedValue('a', 200));
      unmount();
      act(() => vi.advanceTimersByTime(500));
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useUnsavedChangesWarning', () => {
  it('registers no listener when the form is clean', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderHook(() => useUnsavedChangesWarning(false));

    const names = addSpy.mock.calls.map(([name]) => name);
    expect(names).not.toContain('beforeunload');
    addSpy.mockRestore();
  });

  it('warns before unload while the form is dirty and cleans up after', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useUnsavedChangesWarning(true));
    expect(addSpy.mock.calls.map(([name]) => name)).toContain('beforeunload');

    unmount();
    expect(removeSpy.mock.calls.map(([name]) => name)).toContain('beforeunload');

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('calls preventDefault on the unload event', () => {
    renderHook(() => useUnsavedChangesWarning(true));

    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalled();
  });
});

describe('useDocumentTitle', () => {
  it('composes the title with the product name', () => {
    renderHook(() => useDocumentTitle('Products'));
    expect(document.title).toBe('Products · Aurora Catalogue');
  });

  it('falls back to the base title', () => {
    renderHook(() => useDocumentTitle(''));
    expect(document.title).toBe('Aurora Catalogue');
  });

  it('updates when the title changes', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'Products' },
    });
    rerender({ title: 'Brands' });
    expect(document.title).toBe('Brands · Aurora Catalogue');
  });
});

/**
 * Listing URLs carry the filter set only. Pagination is internal state, so a
 * `?page=` must be removable on sight — from an old bookmark, a hand-edited address
 * or the `fromSearch` state of a detail page opened before the change.
 */
describe('stripPagination', () => {
  it('removes the pagination parameter and keeps the filter set intact', () => {
    const params = new URLSearchParams('brand=brand-1&page=3&sort=price_asc');

    const stripped = stripPagination(params);

    expect(stripped.has(PAGINATION_PARAM)).toBe(false);
    expect(stripped.get('brand')).toBe('brand-1');
    expect(stripped.get('sort')).toBe('price_asc');
    // The caller's params are not mutated.
    expect(params.get('page')).toBe('3');
  });

  it('drops a pagination-only query string entirely', () => {
    expect(stripPagination(new URLSearchParams('page=2')).toString()).toBe('');
  });

  it('returns the same instance when there is nothing to strip', () => {
    const params = new URLSearchParams('search=lamp');
    expect(stripPagination(params)).toBe(params);
  });

  it('tolerates a missing search-params object', () => {
    expect(stripPagination(undefined)).toBeUndefined();
  });
});
