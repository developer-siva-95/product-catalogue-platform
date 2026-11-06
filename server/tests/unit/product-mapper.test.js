import { describe, it, expect } from 'vitest';
import {
  LOW_STOCK_THRESHOLD,
  STOCK_STATUS,
  stockStatusFor,
  toAdminProduct,
  toPublicProduct,
} from '../../src/repositories/product.mapper.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fixture loaded via fs: ESLint's parser does not yet accept import attributes. */
const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/p1/product-mapper-golden.json', import.meta.url)),
    'utf8',
  ),
);
import { LOW_STOCK_THRESHOLD as MODEL_LOW_STOCK_THRESHOLD } from '../../src/modules/products/model.js';

/**
 * The mappers were extracted from `modules/products/service.js` in P1 with no
 * behaviour change. `fixtures/p1/product-mapper-golden.json` is the output of the
 * ORIGINAL implementation, captured before the extraction; every case below must
 * still match it key-for-key, in order, with identical value types.
 */

/** Rebuilds a fixture input, restoring sentinel-marked `undefined` values and Dates. */
function buildInput(input) {
  const doc = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === '__undefined__') {
      doc[key] = undefined;
      continue;
    }
    doc[key] = key === 'createdAt' || key === 'updatedAt' ? new Date(value) : value;
  }
  return doc;
}

describe('repositories/product.mapper', () => {
  it('has a golden fixture captured from the pre-extraction implementation', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(16);
    expect(new Set(golden.cases.map((c) => c.name)).size).toBe(golden.cases.length);
  });

  describe.each(golden.cases.map((testCase) => [testCase.name, testCase]))(
    'case %s',
    (_name, testCase) => {
      const doc = buildInput(testCase.input);

      it('public shape matches the original implementation exactly', () => {
        const actual = JSON.parse(JSON.stringify(toPublicProduct(doc)));
        expect(actual).toEqual(testCase.public);
      });

      it('public shape preserves JSON key order', () => {
        expect(Object.keys(toPublicProduct(doc))).toEqual(Object.keys(testCase.public));
      });

      it('admin shape matches the original implementation exactly', () => {
        const actual = JSON.parse(JSON.stringify(toAdminProduct(doc)));
        expect(actual).toEqual(testCase.admin);
      });

      it('admin shape preserves JSON key order and appends `version` last', () => {
        const keys = Object.keys(toAdminProduct(doc));
        expect(keys).toEqual(Object.keys(testCase.admin));
        expect(keys.at(-1)).toBe('version');
      });
    },
  );

  it('keeps money a number and never a string', () => {
    const mapped = toPublicProduct(buildInput(golden.cases[0].input));
    expect(typeof mapped.price).toBe('number');
    expect(mapped.price).toBe(19.99);
  });

  it('keeps timestamps as Date objects (serialised to ISO-8601 UTC by Express)', () => {
    const mapped = toPublicProduct(buildInput(golden.cases[0].input));
    expect(mapped.createdAt).toBeInstanceOf(Date);
    expect(mapped.updatedAt).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(mapped)).updatedAt).toBe('2026-01-02T08:30:15.250Z');
  });

  describe('stockStatusFor', () => {
    it('matches the thresholds the storefront already published', () => {
      expect(MODEL_LOW_STOCK_THRESHOLD).toBe(LOW_STOCK_THRESHOLD);
      expect(stockStatusFor(0)).toBe(STOCK_STATUS.OUT_OF_STOCK);
      expect(stockStatusFor(1)).toBe(STOCK_STATUS.LOW_STOCK);
      expect(stockStatusFor(5)).toBe(STOCK_STATUS.LOW_STOCK);
      expect(stockStatusFor(6)).toBe(STOCK_STATUS.IN_STOCK);
      expect(stockStatusFor(999_999)).toBe(STOCK_STATUS.IN_STOCK);
    });
  });

  it('accepts a document-like value (toObject) exactly like the original', () => {
    const plain = buildInput(golden.cases[0].input);
    const docLike = { ...plain, toObject: () => plain };
    expect(JSON.parse(JSON.stringify(toPublicProduct(docLike)))).toEqual(golden.cases[0].public);
  });
});
