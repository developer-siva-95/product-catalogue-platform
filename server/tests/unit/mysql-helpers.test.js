import { describe, it, expect } from 'vitest';
import { mapMysqlError, duplicateKeyField } from '../../src/repositories/mysql/error-mapping.js';
import { mapDatabaseError } from '../../src/repositories/error-mapping.js';
import {
  containsPattern,
  escapeLike,
  orderByBinary,
  placeholders,
  toNumber,
} from '../../src/repositories/mysql/sql.js';
import { newObjectIdHex, timestampOf } from '../../src/repositories/mysql/objectid.js';

/**
 * MySQL-side helpers, tested without a server.
 *
 * These are the pieces that decide whether a MySQL failure looks like the MongoDB
 * failure to an API client, and whether user input that contains SQL wildcards is
 * still treated as literal text.
 */
describe('MySQL error mapping', () => {
  it('maps a duplicate key to the same 409 payload the Mongo provider produces', () => {
    const mapped = mapMysqlError({
      errno: 1062,
      code: 'ER_DUP_ENTRY',
      sqlMessage: "Duplicate entry 'acme-2' for key 'brands.brand_slug_unique'",
    });

    expect(mapped).toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_KEY',
      details: { field: 'slug' },
      isOperational: true,
    });
    expect(mapped.message).toBe('A record with this slug already exists.');
  });

  it('names the field from the index, for every unique index in the schema', () => {
    const cases = [
      ['product_slug_unique', 'slug'],
      ['product_sku_unique_sparse', 'sku'],
      ['brand_name_normalized_unique', 'name'],
      ['category_name_normalized_unique', 'name'],
      ['email_unique', 'email'],
    ];
    for (const [index, field] of cases) {
      expect(duplicateKeyField({ sqlMessage: `Duplicate entry 'x' for key 't.${index}'` })).toBe(
        field,
      );
    }
    expect(duplicateKeyField({ sqlMessage: 'Duplicate entry for key' })).toBe('field');
  });

  it('maps a blocked delete and a bad foreign key to distinct codes', () => {
    expect(mapMysqlError({ errno: 1451, code: 'ER_ROW_IS_REFERENCED_2' })).toMatchObject({
      statusCode: 409,
      code: 'RESOURCE_IN_USE',
    });
    expect(
      mapMysqlError({
        errno: 1452,
        code: 'ER_NO_REFERENCED_ROW_2',
        sqlMessage:
          'Cannot add or update a child row: a foreign key constraint fails (`db`.`products`, CONSTRAINT `product_brand_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`))',
      }),
    ).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: { constraint: 'product_brand_fk' },
    });
  });

  it('maps data-level and lock-level failures', () => {
    expect(mapMysqlError({ errno: 1406 })).toMatchObject({ statusCode: 422 });
    expect(mapMysqlError({ errno: 3819 })).toMatchObject({ statusCode: 422 });
    expect(mapMysqlError({ errno: 1213 })).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(mapMysqlError({ errno: 1205 })).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('leaves unknown errors to the generic handler', () => {
    expect(mapMysqlError({ errno: 9999 })).toBeNull();
    expect(mapMysqlError(null)).toBeNull();
  });

  it('is reachable through the provider-neutral mapper', () => {
    expect(
      mapDatabaseError({ errno: 1062, sqlMessage: "Duplicate entry '1' for key 't.email_unique'" }),
    ).toMatchObject({ code: 'DUPLICATE_KEY', details: { field: 'email' } });
  });
});

describe('SQL helpers', () => {
  it('escapes LIKE wildcards so a search is always literal', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(containsPattern('acme')).toBe('%acme%');
  });

  it('builds placeholder lists and refuses an empty IN ()', () => {
    expect(placeholders(3)).toBe('?, ?, ?');
    expect(placeholders(0)).toBe('NULL');
  });

  it('converts DECIMAL strings to numbers, preserving null', () => {
    expect(toNumber('19.99')).toBe(19.99);
    expect(toNumber(1000)).toBe(1000);
    expect(toNumber(null)).toBeNull();
  });

  it('pins binary collation for text ordering only', () => {
    expect(orderByBinary('b.name', 'DESC')).toBe('b.name COLLATE utf8mb4_bin DESC');
  });
});

describe('ObjectId-compatible ids', () => {
  it('produces 24 lowercase hex characters', () => {
    const id = newObjectIdHex();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(newObjectIdHex()).not.toBe(id);
  });

  it('encodes the creation second, so id order equals creation order', () => {
    const early = newObjectIdHex(new Date('2026-01-01T00:00:00.000Z'));
    const late = newObjectIdHex(new Date('2026-06-01T00:00:00.000Z'));

    expect(timestampOf(early)).toBe(Date.UTC(2026, 0, 1) / 1000);
    expect(early < late).toBe(true);
    expect(timestampOf(late)).toBe(Date.UTC(2026, 5, 1) / 1000);
  });

  it('increments monotonically within the same second', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const ids = Array.from({ length: 50 }, () => newObjectIdHex(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
