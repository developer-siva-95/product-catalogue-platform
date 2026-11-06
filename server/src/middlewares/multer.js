import multer from 'multer';
import env from '../config/env.js';
import { UPLOAD } from '../constants/appConstants.js';
import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';

/**
 * Upload handling — MEMORY storage only.
 *
 * Nothing is written to disk before validation succeeds: the buffer is checked
 * for magic bytes, size, dimensions and decodability, then sharp re-encodes it
 * into a new file with a generated name. Client-supplied filenames are therefore
 * never used on the filesystem (no traversal, no overwrite, no polyglot files).
 */
const storage = multer.memoryStorage();

const fileFilter = (_req, file, callback) => {
  // Cheap early rejection using the declared type; the authoritative check is the
  // magic-byte/decoding validation in fileValidator (client MIME is untrusted).
  if (!UPLOAD.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return callback(
      ApiError.unprocessable('Only JPEG, PNG and WEBP images are accepted', {
        code: 'UNSUPPORTED_FILE_TYPE',
      }),
    );
  }
  return callback(null, true);
};

export const uploadProductImage = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.MAX_UPLOAD_BYTES ?? UPLOAD.MAX_BYTES,
    files: 1,
    fields: 20,
    parts: 25,
  },
}).single(UPLOAD.FIELD_NAME);

/**
 * Express wrapper that normalises multer's errors into the API envelope.
 * (multer forwards its own errors, which errorHandler already maps; this adds the
 * "unexpected file" case with a clearer hint.)
 */
export function handleProductImageUpload(req, res, next) {
  uploadProductImage(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(
          new ApiError(
            HTTP_STATUS.PAYLOAD_TOO_LARGE,
            `Image exceeds the ${Math.floor((env.MAX_UPLOAD_BYTES ?? UPLOAD.MAX_BYTES) / (1024 * 1024))}MB limit`,
            { code: 'FILE_TOO_LARGE' },
          ),
        );
      }
      return next(ApiError.badRequest(`Upload rejected: ${error.code}`, { code: error.code }));
    }
    return next(error);
  });
}

export default { handleProductImageUpload, uploadProductImage };
