import { describe, it, expect, vi } from 'vitest';
import {
  generateSku,
  createUniqueSku,
  normalizeSkuPrefix,
  saveWithSkuRetry,
} from '../../src/utils/skuGenerator.js';

describe('normalizeSkuPrefix', () => {
  it('uppercases, strips non letters and pads to three characters', () => {
    expect(normalizeSkuPrefix('electronics')).toBe('ELE');
    expect(normalizeSkuPrefix('Audio')).toBe('AUD');
    expect(normalizeSkuPrefix('Hi-Fi')).toBe('HIF');
    expect(normalizeSkuPrefix('A')).toBe('AXX');
    expect(normalizeSkuPrefix('')).toBe('SKU');
    expect(normalizeSkuPrefix(null)).toBe('SKU');
  });
});

describe('generateSku', () => {
  it('matches the documented format', () => {
    expect(generateSku({ prefix: 'Audio' })).toMatch(/^AUD-[A-Z2-9]{7}$/);
  });

  it('excludes look-alike characters (0, O, 1, I)', () => {
    for (let i = 0; i < 200; i += 1) {
      const suffix = generateSku().split('-')[1];
      expect(suffix).not.toMatch(/[01OI]/);
    }
  });

  it('produces practically unique values', () => {
    const skus = new Set(Array.from({ length: 5000 }, () => generateSku({ prefix: 'x' })));
    expect(skus.size).toBe(5000);
  });
});

describe('createUniqueSku', () => {
  it('allocates a free SKU immediately when there is no collision', async () => {
    const model = { exists: vi.fn().mockResolvedValue(null) };
    await expect(createUniqueSku(model, { prefix: 'Audio' })).resolves.toMatch(/^AUD-/);
    expect(model.exists).toHaveBeenCalledTimes(1);
  });

  it('retries when a SKU is already taken', async () => {
    const model = { exists: vi.fn().mockResolvedValueOnce({ _id: 1 }).mockResolvedValueOnce(null) };
    await expect(createUniqueSku(model, { prefix: 'Audio' })).resolves.toMatch(/^AUD-/);
    expect(model.exists).toHaveBeenCalledTimes(2);
  });

  it('excludes the current document when regenerating', async () => {
    const model = { exists: vi.fn().mockResolvedValue(null) };
    await createUniqueSku(model, { excludeId: 'p1' });
    expect(model.exists.mock.calls[0][0]).toHaveProperty('_id', { $ne: 'p1' });
  });

  it('fails loudly after exhausting attempts instead of looping forever', async () => {
    const model = { exists: vi.fn().mockResolvedValue({ _id: 'taken' }) };
    // maxAttempts: 0 keeps the test instant while exercising the same branch
    await expect(createUniqueSku(model, { maxAttempts: 0 })).rejects.toThrow(/unique SKU/);
  });
});

describe('saveWithSkuRetry', () => {
  it('regenerates the SKU and retries on a duplicate-key race', async () => {
    const duplicate = Object.assign(new Error('E11000'), { code: 11000 });
    const operation = vi.fn().mockRejectedValueOnce(duplicate).mockResolvedValue('saved');
    await expect(saveWithSkuRetry(operation)).resolves.toBe('saved');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
