import { describe, it, expect, vi } from 'vitest';
import {
  slugify,
  createUniqueSlug,
  withDuplicateKeyRetry,
  withSuffix,
} from '../../src/utils/slugify.js';

describe('slugify', () => {
  it('produces lowercase, hyphenated ASCII slugs', () => {
    expect(slugify('Aurora Studio Wireless Headphones')).toBe('aurora-studio-wireless-headphones');
    expect(slugify('  Multiple   spaces  ')).toBe('multiple-spaces');
    expect(slugify('Café Crème à l’Orange')).toBe('cafe-creme-a-l-orange');
    expect(slugify('Ünïcode — test!!')).toBe('unicode-test');
  });

  it('handles empty and non-string input without throwing', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
    expect(slugify(12345)).toBe('12345');
  });

  it('caps slug length and never ends with a hyphen', () => {
    const slug = slugify('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('withSuffix', () => {
  it('appends a numeric suffix and keeps the length cap', () => {
    expect(withSuffix('aurora', 2)).toBe('aurora-2');
    expect(withSuffix('a'.repeat(80), 12).length).toBeLessThanOrEqual(80);
    expect(withSuffix('a'.repeat(80), 12).endsWith('-12')).toBe(true);
  });
});

describe('createUniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    const model = { exists: vi.fn().mockResolvedValue(null) };
    await expect(createUniqueSlug(model, 'NovaTech Air 14')).resolves.toBe('novatech-air-14');
  });

  it('appends an incrementing suffix while slugs are taken', async () => {
    const taken = new Set(['aurora', 'aurora-2']);
    const model = { exists: vi.fn(async ({ slug }) => (taken.has(slug) ? { _id: slug } : null)) };
    await expect(createUniqueSlug(model, 'Aurora')).resolves.toBe('aurora-3');
  });

  it('excludes the current document when renaming', async () => {
    const model = { exists: vi.fn().mockResolvedValue(null) };
    await createUniqueSlug(model, 'Aurora', { excludeId: 'abc' });
    expect(model.exists).toHaveBeenCalledWith({ slug: 'aurora', _id: { $ne: 'abc' } });
  });

  it('falls back to the provided fallback for unsluggable text', async () => {
    const model = { exists: vi.fn().mockResolvedValue(null) };
    await expect(createUniqueSlug(model, '!!!', { fallback: 'product' })).resolves.toBe('product');
  });

  it('never throws even if every attempt collides (timestamp fallback)', async () => {
    const model = { exists: vi.fn().mockResolvedValue({ _id: 'always' }) };
    const slug = await createUniqueSlug(model, 'Busy Name', { maxAttempts: 3 });
    expect(slug.startsWith('busy-name')).toBe(true);
  });
});

describe('withDuplicateKeyRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withDuplicateKeyRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on duplicate key errors (11000) and then succeeds', async () => {
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(duplicate)
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValue('third-time');
    await expect(withDuplicateKeyRetry(operation)).resolves.toBe('third-time');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-duplicate errors', async () => {
    const boom = Object.assign(new Error('other'), { code: 500 });
    const operation = vi.fn().mockRejectedValue(boom);
    await expect(withDuplicateKeyRetry(operation)).rejects.toThrow('other');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last duplicate key error after exhausting attempts', async () => {
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const operation = vi.fn().mockRejectedValue(duplicate);
    await expect(withDuplicateKeyRetry(operation, { maxAttempts: 3 })).rejects.toThrow('E11000');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
