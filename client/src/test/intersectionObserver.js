import { vi } from 'vitest';

/**
 * Controllable `IntersectionObserver` stub.
 *
 * jsdom has no layout engine, so a real observer would never fire. This stub
 * records every observer, lets a test report the sentinel's visibility explicitly,
 * and exposes `disconnect()` state so leaks can be asserted.
 */
export function stubIntersectionObserver() {
  const observers = [];

  class MockIntersectionObserver {
    constructor(callback, options = {}) {
      this.callback = callback;
      this.options = options;
      this.elements = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(element) {
      if (!this.elements.includes(element)) this.elements.push(element);
    }

    unobserve(element) {
      this.elements = this.elements.filter((item) => item !== element);
    }

    disconnect() {
      this.disconnected = true;
      this.elements = [];
    }

    takeRecords() {
      return [];
    }

    /** Reports `isIntersecting` for every observed element. */
    emit(isIntersecting = true) {
      if (this.disconnected || this.elements.length === 0) return;
      this.callback(
        this.elements.map((target) => ({
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
          boundingClientRect: target.getBoundingClientRect?.(),
          intersectionRect: {},
          rootBounds: null,
          time: 0,
        })),
        this,
      );
    }
  }

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  return {
    /** Number of observers ever created. */
    created: () => observers.length,
    /** Observers that have not been disconnected. */
    live: () => observers.filter((observer) => !observer.disconnected),
    options: () => observers.map((observer) => observer.options),
    /** Simulates the sentinel scrolling into view. */
    emit(isIntersecting = true) {
      for (const observer of observers.filter((item) => !item.disconnected)) {
        observer.emit(isIntersecting);
      }
    },
  };
}

/**
 * Controllable `matchMedia` stub.
 *
 * `matches` maps a query string to its result; `set()` flips a query and notifies
 * the listeners the way a real breakpoint change would.
 */
export function stubMatchMedia(matches = {}) {
  const listeners = new Set();
  const state = { ...matches };

  const createList = (query) => ({
    matches: Boolean(state[query]),
    media: query,
    onchange: null,
    addEventListener: (_event, handler) => listeners.add(handler),
    removeEventListener: (_event, handler) => listeners.delete(handler),
    addListener: (handler) => listeners.add(handler),
    removeListener: (handler) => listeners.delete(handler),
    dispatchEvent: () => true,
  });

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query) => createList(query)),
  );

  return {
    set(query, value) {
      state[query] = value;
      for (const handler of listeners) handler({ matches: value, media: query });
    },
  };
}

/** Convenience wrapper for the storefront breakpoint. */
export function stubMobileViewport(isMobile = true) {
  return stubMatchMedia({ '(max-width: 900px)': isMobile });
}
