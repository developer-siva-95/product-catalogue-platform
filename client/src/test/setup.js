import { expect, afterEach, vi } from 'vitest';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

/**
 * jest-dom's own `/vitest` entry imports `expect` from whatever copy of vitest
 * resolves from *its* directory. With npm workspaces that can be a second,
 * hoisted vitest instance, in which case the matchers are attached to the wrong
 * chai and every `toBeInTheDocument()` throws "Invalid Chai property". Extending
 * the expect instance this file imports from `vitest` is resolution-proof and
 * gives exactly the same matchers.
 */
expect.extend(jestDomMatchers);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom lacks these APIs; several components rely on them.
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
