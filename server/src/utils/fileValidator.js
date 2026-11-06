import path from 'node:path';
import sharp from 'sharp';
import env from '../config/env.js';
import { UPLOAD } from '../constants/appConstants.js';
import { ApiError } from './ApiError.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';

/**
 * Upload validation.
 *
 * Trust nothing the client says about the file:
 *  1. magic bytes decide the real type (the declared MIME type and the filename
 *     extension are attacker-controlled);
 *  2. size is capped before any decoding happens;
 *  3. dimensions/pixel count are capped to stop decompression bombs;
 *  4. the image is actually decoded (sharp) so polyglot/corrupt payloads fail
 *     before they are written to disk.
 */

/** @typedef {{ format: 'jpeg'|'png'|'webp', mime: string }} DetectedImageType */

const SIGNATURES = [
  {
    format: 'jpeg',
    mime: 'image/jpeg',
    test: (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    format: 'png',
    mime: 'image/png',
    test: (buf) =>
      buf.length > 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a,
  },
  {
    format: 'webp',
    mime: 'image/webp',
    test: (buf) =>
      buf.length > 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP',
  },
];

/**
 * Detects an image type from its magic bytes.
 * @param {Buffer} buffer
 * @returns {DetectedImageType|null}
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const match = SIGNATURES.find((signature) => signature.test(buffer));
  return match ? { format: match.format, mime: match.mime } : null;
}

export function isSupportedMimeType(mime) {
  return UPLOAD.ALLOWED_MIME_TYPES.includes(mime);
}

/**
 * Structural + signature validation of a multer memory-storage file.
 * @param {Express.Multer.File|undefined} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {DetectedImageType}
 */
export function validateUploadedFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? env.MAX_UPLOAD_BYTES ?? UPLOAD.MAX_BYTES;

  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw ApiError.badRequest('An image file is required', { code: 'FILE_REQUIRED' });
  }
  if (file.size === 0 || file.buffer.length === 0) {
    throw ApiError.badRequest('The uploaded file is empty', { code: 'EMPTY_FILE' });
  }
  if (file.buffer.length > maxBytes) {
    throw new ApiError(
      HTTP_STATUS.PAYLOAD_TOO_LARGE,
      `Image exceeds the maximum allowed size of ${Math.floor(maxBytes / (1024 * 1024))}MB`,
      { code: 'FILE_TOO_LARGE', details: { maxBytes } },
    );
  }

  const detected = detectImageType(file.buffer);
  if (!detected) {
    throw new ApiError(
      HTTP_STATUS.UNPROCESSABLE_ENTITY,
      'Unsupported or corrupt image file. Allowed formats: JPEG, PNG, WEBP.',
      { code: 'UNSUPPORTED_FILE_TYPE' },
    );
  }

  // A mismatched declared type is a strong signal of a disguised payload.
  if (file.mimetype && isSupportedMimeType(file.mimetype) && file.mimetype !== detected.mime) {
    throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'File type does not match its content', {
      code: 'MIME_TYPE_MISMATCH',
      details: { declared: file.mimetype, detected: detected.mime },
    });
  }

  return detected;
}

/**
 * Verifies dimensions and pixel count AND proves the payload really decodes.
 * @param {Buffer} buffer
 * @returns {Promise<{ format: string, width: number, height: number }>}
 */
export async function validateImageMetadata(buffer) {
  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: UPLOAD.MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Image could not be decoded', {
      code: 'IMAGE_DECODE_FAILED',
      cause: error,
    });
  }

  const { width = 0, height = 0, format } = metadata;
  if (!width || !height) {
    throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Image has no usable dimensions', {
      code: 'IMAGE_DIMENSIONS_INVALID',
    });
  }
  if (width < UPLOAD.MIN_WIDTH || height < UPLOAD.MIN_HEIGHT) {
    throw ApiError.badRequest(
      `Image must be at least ${UPLOAD.MIN_WIDTH}x${UPLOAD.MIN_HEIGHT} pixels`,
      { code: 'IMAGE_TOO_SMALL', details: { width, height } },
    );
  }
  if (width * height > UPLOAD.MAX_INPUT_PIXELS) {
    throw new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, 'Image pixel count exceeds the limit', {
      code: 'IMAGE_PIXELS_EXCEEDED',
      details: { width, height, maxPixels: UPLOAD.MAX_INPUT_PIXELS },
    });
  }
  if (!['jpeg', 'png', 'webp'].includes(format)) {
    throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, `Unsupported image format: ${format}`, {
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  }

  return { format, width, height };
}

/**
 * Resolves `filename` inside `directory` and refuses path traversal.
 * Defence in depth for the cleanup routine (filenames come from the DB, which
 * could have been tampered with).
 *
 * @param {string} directory absolute base directory
 * @param {string} filename
 * @returns {string} absolute path guaranteed to live inside `directory`
 */
export function resolveWithinDirectory(directory, filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw ApiError.badRequest('Invalid file name', { code: 'INVALID_FILE_NAME' });
  }
  const baseDir = path.resolve(directory);
  const resolved = path.resolve(baseDir, path.basename(filename));
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('\0')) {
    throw ApiError.badRequest('Path traversal attempt blocked', { code: 'PATH_TRAVERSAL_BLOCKED' });
  }
  return resolved;
}

export default {
  detectImageType,
  isSupportedMimeType,
  validateUploadedFile,
  validateImageMetadata,
  resolveWithinDirectory,
};
