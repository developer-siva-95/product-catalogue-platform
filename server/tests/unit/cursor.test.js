import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, hashFilters } from '../../src/utils/cursor.js';
import { isValidObjectId } from '../../src/utils/validators.js';

const ID_A = '6511f0aaa1b2c3d4e5f60718';
const ID_B = '6511f0aaa1b2c3d4e5f60719';

describe('cursor encoding', () => {
  it('round-trips a newest cursor', () => {
    const token = encodeCursor({ sort: 'newest', id: ID_A, filterHash: 'abc123' });
    expect(token).toContain('.');
    expect(decodeCursor(token, { sort: 'newest', filterHash: 'abc123' })).toEqual({
      sort: 'newest',
      id: ID_A,
    });
  });

  it('round-trips compound price cursors including the price', () => {
    const ascending = encodeCursor({ sort: 'price_asc', id: ID_B, price: 1299.5, filterHash: 'h' });
    expect(decodeCursor(ascending, { sort: 'price_asc', filterHash: 'h' })).toEqual({
      sort: 'price_asc',
      id: ID_B,
      price: 1299.5,
    });

    const descending = encodeCursor({ sort: 'price_desc', id: ID_B, price: 0, filterHash: 'h' });
    expect(decodeCursor(descending, { sort: 'price_desc', filterHash: 'h' }).price).toBe(0);
  });

  it('refuses to encode a compound cursor without a price or with a bad id', () => {
    expect(() => encodeCursor({ sort: 'price_asc', id: ID_A, filterHash: 'h' })).toThrow(
      /numeric price/,
    );
    expect(() => encodeCursor({ sort: 'newest', id: 'not-an-id', filterHash: 'h' })).toThrow(
      /ObjectId/,
    );
    expect(() => encodeCursor({ sort: 'bogus', id: ID_A, filterHash: 'h' })).toThrow(
      /unsupported sort/,
    );
  });
});

describe('cursor validation', () => {
  const context = { sort: 'newest', filterHash: 'abc123' };

  it.each([
    ['empty string', ''],
    ['no separator', 'abcdef'],
    ['too many segments', 'a.b.c'],
    ['not a string', 42],
    ['over-long', 'a'.repeat(600)],
  ])('rejects malformed cursors (%s)', (_label, token) => {
    expect(() => decodeCursor(token, context)).toThrow(/Cursor/);
  });

  it('rejects a tampered signature', () => {
    const token = encodeCursor({ sort: 'newest', id: ID_A, filterHash: 'abc123' });
    const [payload, signature] = token.split('.');
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decodeCursor(tampered, context)).toThrow(/signature is invalid/);
  });

  it('rejects a tampered payload even when the signature segment is reused', () => {
    const token = encodeCursor({ sort: 'newest', id: ID_A, filterHash: 'abc123' });
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, s: 'newest', i: ID_B, f: 'abc123' }),
    ).toString('base64url');
    expect(() => decodeCursor(`${forgedPayload}.${signature}`, context)).toThrow(/signature/);
  });

  it('rejects a cursor minted for another sort', () => {
    const token = encodeCursor({ sort: 'price_asc', id: ID_A, price: 10, filterHash: 'abc123' });
    try {
      decodeCursor(token, context);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('CURSOR_SORT_MISMATCH');
      expect(error.message).toMatch(/issued for sort "price_asc"/);
    }
  });

  it('rejects a cursor minted for different filters', () => {
    const token = encodeCursor({ sort: 'newest', id: ID_A, filterHash: 'other-filters' });
    try {
      decodeCursor(token, context);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('CURSOR_FILTER_MISMATCH');
    }
  });

  it('rejects a cursor whose payload version is unsupported', () => {
    // A version bump is how old cursors are invalidated after a deploy.
    const token = encodeCursor({ sort: 'newest', id: ID_A, filterHash: 'abc123' });
    expect(() => decodeCursor(token, { ...context, filterHash: 'abc123' })).not.toThrow();
    const badVersion = `${Buffer.from(JSON.stringify({ v: 99, s: 'newest', i: ID_A, f: 'abc123' })).toString('base64url')}.x`;
    expect(() => decodeCursor(badVersion, context)).toThrow();
  });
});

describe('hashFilters', () => {
  it('is order independent', () => {
    expect(hashFilters({ a: 1, b: 2 })).toBe(hashFilters({ b: 2, a: 1 }));
  });

  it('changes when any filter changes', () => {
    expect(hashFilters({ search: 'x' })).not.toBe(hashFilters({ search: 'y' }));
    expect(hashFilters({ brand: 'a' })).not.toBe(hashFilters({ brand: 'b' }));
    expect(hashFilters({ minPrice: 10 })).not.toBe(hashFilters({ minPrice: 11 }));
  });

  it('ignores empty values so a cleared filter does not invalidate a cursor', () => {
    expect(hashFilters({ search: '', brand: undefined })).toBe(hashFilters({}));
  });

  it('produces a short stable digest', () => {
    const hash = hashFilters({ search: 'laptop', sort: 'newest' });
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashFilters({ search: 'laptop', sort: 'newest' })).toBe(hash);
  });
});

describe('objectId validation helper', () => {
  it('accepts 24-hex ids and rejects 12-byte strings', () => {
    expect(isValidObjectId(ID_A)).toBe(true);
    expect(isValidObjectId('aaaaaaaaaaaa')).toBe(false);
    expect(isValidObjectId('zzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(isValidObjectId(12345)).toBe(false);
  });
});
