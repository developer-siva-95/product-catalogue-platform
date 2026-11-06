import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import env from '../config/env.js';
import { UPLOAD } from '../constants/appConstants.js';
import {
  validateImageMetadata,
  validateUploadedFile,
  resolveWithinDirectory,
} from './fileValidator.js';
import logger from './logger.js';

/**
 * Image pipeline (sharp).
 *
 * Invariants enforced on EVERY stored image:
 *  - output dimensions capped at 1200x1200 (main) and 300x300 (thumbnail);
 *  - output format normalised to strictly `image/webp` or `image/jpeg`;
 *  - all metadata (EXIF/GPS/ICC-comment fields) stripped — sharp omits metadata
 *    unless `withMetadata()` is called, which this pipeline never does;
 *  - filenames are random + timestamped so two uploads can never overwrite each
 *    other and cannot be guessed/enumerated.
 */

const EXTENSION_BY_MIME = Object.freeze({
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
});

/** JPEG input stays JPEG (photographic compatibility); everything else becomes WebP. */
export function resolveOutputMime(detectedFormat) {
  return detectedFormat === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

/**
 * Random, timestamped, collision-free filename.
 * @param {string} mime
 * @param {string} [suffix]
 */
export function buildFileName(mime, suffix = '') {
  const extension = EXTENSION_BY_MIME[mime];
  if (!extension) {
    throw new Error(`Unsupported output mime type: ${mime}`);
  }
  return `${Date.now()}-${randomBytes(8).toString('hex')}${suffix}${extension}`;
}

/** Absolute directory that stores product images. */
export function getProductImageDir() {
  return path.join(env.uploadDir, UPLOAD.DIRECTORY);
}

/** Public URL for a stored file name. */
export function buildPublicUrl(fileName) {
  return `${env.PUBLIC_UPLOAD_PATH}/${UPLOAD.DIRECTORY}/${fileName}`;
}

/**
 * Converts a stored public URL back into an absolute filesystem path.
 * Returns null when the URL is not one of ours (never delete arbitrary files).
 */
export function publicUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith(`${env.PUBLIC_UPLOAD_PATH}/`)) return null;
  const relative = url.slice(env.PUBLIC_UPLOAD_PATH.length + 1);
  const [directory, ...rest] = relative.split('/');
  if (directory !== UPLOAD.DIRECTORY || rest.length !== 1) return null;
  try {
    return resolveWithinDirectory(getProductImageDir(), rest[0]);
  } catch {
    return null;
  }
}

/**
 * Processes an uploaded image and writes the main + thumbnail variants.
 *
 * @param {Buffer} buffer raw upload
 * @param {object} [options]
 * @param {number} [options.mainMaxWidth]
 * @param {number} [options.mainMaxHeight]
 * @returns {Promise<{ image: string, thumbnail: string, imagePath: string, thumbnailPath: string, width: number, height: number, format: string, bytes: number }>}
 */
export async function processAndStoreProductImage(buffer, options = {}) {
  const detected = validateUploadedFile({ buffer, size: buffer.length });
  await validateImageMetadata(buffer);

  const mainMaxWidth = options.mainMaxWidth ?? UPLOAD.MAIN_MAX_WIDTH;
  const mainMaxHeight = options.mainMaxHeight ?? UPLOAD.MAIN_MAX_HEIGHT;
  if (mainMaxWidth > UPLOAD.MAIN_MAX_WIDTH || mainMaxHeight > UPLOAD.MAIN_MAX_HEIGHT) {
    throw new Error('Requested output dimensions exceed the hard limit of 1200x1200');
  }

  const outputMime = resolveOutputMime(detected.format);
  const directory = getProductImageDir();
  await fs.mkdir(directory, { recursive: true });

  const mainFile = buildFileName(outputMime);
  const thumbFile = buildFileName(outputMime, UPLOAD.THUMB_SUFFIX);

  const mainPath = resolveWithinDirectory(directory, mainFile);
  const thumbPath = resolveWithinDirectory(directory, thumbFile);

  const encode = (pipeline) =>
    outputMime === 'image/webp'
      ? pipeline.webp({ quality: UPLOAD.QUALITY, effort: 4 })
      : pipeline.jpeg({ quality: UPLOAD.QUALITY, progressive: true, mozjpeg: true });

  const encodeThumb = (pipeline) =>
    outputMime === 'image/webp'
      ? pipeline.webp({ quality: UPLOAD.THUMB_QUALITY, effort: 4 })
      : pipeline.jpeg({ quality: UPLOAD.THUMB_QUALITY, progressive: true });

  try {
    const mainBuffer = await encode(
      sharp(buffer)
        .rotate() // honour EXIF orientation before metadata is dropped
        .resize({
          width: mainMaxWidth,
          height: mainMaxHeight,
          fit: 'inside',
          withoutEnlargement: true,
        }),
    ).toBuffer();

    const thumbnailBuffer = await encodeThumb(
      sharp(buffer).rotate().resize({
        width: UPLOAD.THUMB_WIDTH,
        height: UPLOAD.THUMB_HEIGHT,
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      }),
    ).toBuffer();

    await fs.writeFile(mainPath, mainBuffer);
    await fs.writeFile(thumbPath, thumbnailBuffer);

    const metadata = await sharp(mainBuffer).metadata();

    return {
      image: buildPublicUrl(mainFile),
      thumbnail: buildPublicUrl(thumbFile),
      imagePath: mainPath,
      thumbnailPath: thumbPath,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      format: metadata.format ?? outputMime,
      bytes: mainBuffer.length + thumbnailBuffer.length,
    };
  } catch (error) {
    // Partial writes must never leak: clean both candidates before rethrowing.
    await removeFiles([mainPath, thumbPath]);
    throw error;
  }
}

/**
 * Best-effort deletion. Missing files are not an error (idempotent cleanup).
 * @param {Array<string|null|undefined>} paths
 * @returns {Promise<number>} number of files actually removed
 */
export async function removeFiles(paths) {
  let removed = 0;
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      await fs.unlink(filePath);
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('failed to remove upload file', { filePath, err: error });
      }
    }
  }
  return removed;
}

/**
 * Removes the main + thumbnail files referenced by stored URLs.
 * Used when a product is deleted or its image is replaced.
 * @param {string[]} urls public URLs (`/uploads/products/...`)
 */
export async function removeImagesByUrl(urls) {
  const paths = urls.map((url) => publicUrlToPath(url)).filter(Boolean);
  return removeFiles(paths);
}

/**
 * Orphan sweeper: deletes files in the upload directory that no product
 * references. Intended to be called by a maintenance job (see README) after a
 * crash between "file written" and "database saved".
 *
 * @param {Set<string>} referencedFileNames file names still referenced by products
 * @returns {Promise<{ scanned: number, removed: number }>}
 */
export async function sweepOrphanedImages(referencedFileNames) {
  const directory = getProductImageDir();
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { scanned: 0, removed: 0 };
    throw error;
  }

  const orphans = entries.filter((name) => !referencedFileNames.has(name));
  const removed = await removeFiles(orphans.map((name) => path.join(directory, name)));
  if (removed > 0) logger.info('orphaned images removed', { removed });
  return { scanned: entries.length, removed };
}

export default {
  processAndStoreProductImage,
  removeFiles,
  removeImagesByUrl,
  sweepOrphanedImages,
  publicUrlToPath,
  buildPublicUrl,
  buildFileName,
  getProductImageDir,
  resolveOutputMime,
};
