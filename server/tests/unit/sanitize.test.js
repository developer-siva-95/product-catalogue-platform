import { describe, it, expect } from 'vitest';
import { sanitizeValue } from '../../src/middlewares/sanitize.js';

describe('sanitizeValue', () => {
  it('strips keys starting with $ (NoSQL operator injection)', () => {
    const dirty = { email: { $ne: null }, $where: 'sleep(1000)' };
    expect(sanitizeValue(dirty)).toEqual({ email: {} });
  });

  it('strips keys containing dots (path traversal in queries)', () => {
    expect(sanitizeValue({ 'user.role': 'admin', role: 'admin' })).toEqual({ role: 'admin' });
  });

  it('sanitises nested objects and arrays', () => {
    const dirty = { a: [{ $gt: 1, keep: true }], b: { c: { $set: { x: 1 }, y: 2 } } };
    expect(sanitizeValue(dirty)).toEqual({ a: [{ keep: true }], b: { c: { y: 2 } } });
  });

  it('leaves primitives and null untouched', () => {
    expect(sanitizeValue('text')).toBe('text');
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(undefined)).toBeUndefined();
  });

  it('does not blow the stack on deeply nested input', () => {
    let deep = { value: 1 };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    expect(() => sanitizeValue(deep)).not.toThrow();
  });
});
