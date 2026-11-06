import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import multer from 'multer';
import { normalizeError } from '../../src/middlewares/errorHandler.js';
import { ApiError } from '../../src/utils/ApiError.js';

describe('normalizeError', () => {
  it('passes ApiError through untouched, preserving code and details', () => {
    const error = ApiError.badRequest('Bad input', { code: 'X', details: [{ path: 'a' }] });
    const normalized = normalizeError(error);
    expect(normalized).toMatchObject({
      statusCode: 400,
      message: 'Bad input',
      code: 'X',
      isOperational: true,
    });
  });

  it('maps Mongoose VersionError to a 409 STALE_RESOURCE', () => {
    const error = new mongoose.Error.VersionError({ _doc: { _id: 'x' } }, 2, ['title']);
    const normalized = normalizeError(error);
    expect(normalized.statusCode).toBe(409);
    expect(normalized.code).toBe('STALE_RESOURCE');
    expect(normalized.message).toMatch(/modified by someone else/i);
  });

  it('maps duplicate key errors to 409 with the offending field', () => {
    const error = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { sku: 1 },
      keyValue: { sku: 'AB-123' },
    });
    const normalized = normalizeError(error);
    expect(normalized.statusCode).toBe(409);
    expect(normalized.code).toBe('DUPLICATE_KEY');
    expect(normalized.details).toEqual({ field: 'sku' });
  });

  it('maps Mongoose ValidationError to 422 with field details', () => {
    const error = new mongoose.Error.ValidationError();
    error.addError(
      'title',
      new mongoose.Error.ValidatorError({ path: 'title', message: 'Title is required' }),
    );
    const normalized = normalizeError(error);
    expect(normalized.statusCode).toBe(422);
    expect(normalized.details).toEqual([{ path: 'title', message: 'Title is required' }]);
  });

  it('maps CastError to 400', () => {
    const error = new mongoose.Error.CastError('ObjectId', 'not-an-id', 'brand');
    const normalized = normalizeError(error);
    expect(normalized.statusCode).toBe(400);
    expect(normalized.code).toBe('INVALID_IDENTIFIER');
    expect(normalized.message).toMatch(/brand/);
  });

  it('maps Multer LIMIT_FILE_SIZE to 413', () => {
    const error = new multer.MulterError('LIMIT_FILE_SIZE', 'image');
    expect(normalizeError(error).statusCode).toBe(413);
    expect(normalizeError(error).code).toBe('LIMIT_FILE_SIZE');
  });

  it('maps other Multer errors to 400', () => {
    expect(normalizeError(new multer.MulterError('LIMIT_UNEXPECTED_FILE')).statusCode).toBe(400);
  });

  it('maps body-parser entity.too.large to 413 and malformed JSON to 400', () => {
    expect(normalizeError({ type: 'entity.too.large' }).statusCode).toBe(413);
    const syntax = new SyntaxError('Unexpected token');
    syntax.body = '{';
    expect(normalizeError(syntax)).toMatchObject({ statusCode: 400, code: 'INVALID_JSON' });
  });

  it('maps JWT errors to 401', () => {
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    expect(normalizeError(expired)).toMatchObject({ statusCode: 401, code: 'TOKEN_EXPIRED' });
  });

  it('treats unknown errors as non-operational 500 and hides the message', () => {
    const normalized = normalizeError(new TypeError('mongo internals leaked'));
    expect(normalized.statusCode).toBe(500);
    expect(normalized.isOperational).toBe(false);
    expect(normalized.message).toBe('Something went wrong');
  });
});
