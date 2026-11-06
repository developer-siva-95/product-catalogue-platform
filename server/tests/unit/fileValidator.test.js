import { describe, it, expect } from 'vitest';
import path from 'node:path';
import sharp from 'sharp';
import {
  detectImageType,
  validateUploadedFile,
  validateImageMetadata,
  resolveWithinDirectory,
  isSupportedMimeType,
} from '../../src/utils/fileValidator.js';

async function jpegBuffer(width = 300, height = 300) {
  return sharp({ create: { width, height, channels: 3, background: '#123456' } })
    .jpeg()
    .toBuffer();
}
async function pngBuffer(width = 300, height = 300) {
  return sharp({ create: { width, height, channels: 4, background: '#abcdef' } })
    .png()
    .toBuffer();
}
async function webpBuffer(width = 300, height = 300) {
  return sharp({ create: { width, height, channels: 3, background: '#abcdef' } })
    .webp()
    .toBuffer();
}

describe('detectImageType (magic bytes)', () => {
  it('detects JPEG, PNG and WEBP from content', async () => {
    expect(detectImageType(await jpegBuffer())?.format).toBe('jpeg');
    expect(detectImageType(await pngBuffer())?.format).toBe('png');
    expect(detectImageType(await webpBuffer())?.format).toBe('webp');
  });

  it('rejects non-image and truncated payloads', () => {
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType('not a buffer')).toBeNull();
  });

  it('does not trust a misleading filename or declared mime type', async () => {
    const png = await pngBuffer();
    const file = {
      buffer: png,
      size: png.length,
      mimetype: 'image/png',
      originalname: 'photo.jpg',
    };
    expect(validateUploadedFile(file).format).toBe('png');
  });
});

describe('validateUploadedFile', () => {
  it('rejects a missing file', () => {
    expect(() => validateUploadedFile(undefined)).toThrow(/image file is required/i);
    expect(() => validateUploadedFile({ buffer: null, size: 0 })).toThrow(/required/i);
  });

  it('rejects empty buffers', async () => {
    const empty = Buffer.alloc(0);
    expect(() => validateUploadedFile({ buffer: empty, size: 0 })).toThrow(/empty/i);
  });

  it('rejects files over the size limit with 413', async () => {
    const buffer = await pngBuffer();
    expect(() => validateUploadedFile({ buffer, size: buffer.length }, { maxBytes: 10 })).toThrow(
      /maximum allowed size/i,
    );
    try {
      validateUploadedFile({ buffer, size: buffer.length }, { maxBytes: 10 });
    } catch (error) {
      expect(error.statusCode).toBe(413);
      expect(error.code).toBe('FILE_TOO_LARGE');
    }
  });

  it('rejects a declared mime type that contradicts the content', async () => {
    const jpeg = await jpegBuffer();
    try {
      validateUploadedFile({ buffer: jpeg, size: jpeg.length, mimetype: 'image/png' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('MIME_TYPE_MISMATCH');
      expect(error.details).toEqual({ declared: 'image/png', detected: 'image/jpeg' });
    }
  });

  it('rejects disguised executables (magic bytes win over mimetype)', () => {
    const payload = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500, 0)]);
    try {
      validateUploadedFile({ buffer: payload, size: payload.length, mimetype: 'image/jpeg' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(error.statusCode).toBe(422);
    }
  });

  it('exposes the supported mime type list', () => {
    expect(isSupportedMimeType('image/webp')).toBe(true);
    expect(isSupportedMimeType('image/gif')).toBe(false);
  });
});

describe('validateImageMetadata', () => {
  it('accepts a normal image and reports dimensions', async () => {
    const meta = await validateImageMetadata(await jpegBuffer(640, 480));
    expect(meta).toMatchObject({ format: 'jpeg', width: 640, height: 480 });
  });

  it('rejects images smaller than the minimum dimensions', async () => {
    await expect(validateImageMetadata(await jpegBuffer(50, 50))).rejects.toThrow(
      /at least 100x100/,
    );
  });

  it('rejects corrupt data that passed the magic-byte check', async () => {
    const jpeg = await jpegBuffer();
    const corrupt = Buffer.concat([jpeg.subarray(0, 40), Buffer.alloc(20, 0x00)]);
    await expect(validateImageMetadata(corrupt)).rejects.toThrow(/could not be decoded/i);
  });
});

describe('resolveWithinDirectory (path traversal protection)', () => {
  // Expectations are derived with this platform's own path semantics: the unit under
  // test returns a *native* absolute path, so a hard-coded POSIX string would only
  // hold on POSIX. `path.resolve` is also exactly what the implementation uses.
  const baseDir = '/tmp/uploads';
  const expected = (...segments) => path.resolve(baseDir, ...segments);

  it('resolves a normal filename inside the base directory', () => {
    expect(resolveWithinDirectory(baseDir, 'photo.webp')).toBe(expected('photo.webp'));
  });

  it('strips directory components from the filename', () => {
    expect(resolveWithinDirectory(baseDir, '../../etc/passwd')).toBe(expected('passwd'));
    expect(resolveWithinDirectory(baseDir, 'nested/photo.webp')).toBe(expected('photo.webp'));
  });

  it('keeps every resolved path inside the base directory', () => {
    for (const filename of ['photo.webp', '../../etc/passwd', 'nested/photo.webp', 'a/../b.webp']) {
      const resolved = resolveWithinDirectory(baseDir, filename);
      const relative = path.relative(path.resolve(baseDir), resolved);
      expect(relative.startsWith('..'), `${filename} escaped the base directory`).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  it('rejects a filename that resolves to the directory itself', () => {
    expect(() => resolveWithinDirectory(baseDir, '..')).toThrow(/Path traversal/);
  });

  it('rejects null bytes and invalid names', () => {
    expect(() => resolveWithinDirectory(baseDir, 'photo.webp\0.jpg')).toThrow();
    expect(() => resolveWithinDirectory(baseDir, '')).toThrow(/Invalid file name/);
    expect(() => resolveWithinDirectory(baseDir, undefined)).toThrow(/Invalid file name/);
  });
});
