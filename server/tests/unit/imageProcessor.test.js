import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  processAndStoreProductImage,
  buildFileName,
  buildPublicUrl,
  publicUrlToPath,
  getProductImageDir,
  removeImagesByUrl,
  sweepOrphanedImages,
  resolveOutputMime,
} from '../../src/utils/imageProcessor.js';

async function makeImage(width, height, format = 'jpeg', options = {}) {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: options.background ?? '#336699' },
  });
  if (format === 'png') return pipeline.png().toBuffer();
  if (format === 'webp') return pipeline.webp().toBuffer();
  pipeline = pipeline.jpeg();
  if (options.exif) pipeline = pipeline.withMetadata({ exif: options.exif });
  return pipeline.toBuffer();
}

const stored = [];

describe('image processing limits (sharp)', () => {
  it('caps the main image at 1200x1200 without enlarging smaller images', async () => {
    const result = await processAndStoreProductImage(await makeImage(3000, 1000, 'jpeg'));
    stored.push(result);
    expect(result.image).toMatch(/^\/uploads\/products\/\d+-[a-f0-9]{16}\.jpg$/);
    expect(result.width).toBe(1200);
    expect(result.height).toBe(400);

    const small = await processAndStoreProductImage(await makeImage(800, 600, 'png'));
    stored.push(small);
    expect(small.width).toBe(800);
    expect(small.height).toBe(600);
  });

  it('generates an exact 300x300 thumbnail', async () => {
    const result = await processAndStoreProductImage(await makeImage(1600, 900, 'jpeg'));
    stored.push(result);
    const meta = await sharp(result.thumbnailPath).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(300);
  });

  it('normalises output to webp or jpeg only', async () => {
    const fromPng = await processAndStoreProductImage(await makeImage(600, 600, 'png'));
    const fromJpeg = await processAndStoreProductImage(await makeImage(600, 600, 'jpeg'));
    const fromWebp = await processAndStoreProductImage(await makeImage(600, 600, 'webp'));
    stored.push(fromPng, fromJpeg, fromWebp);

    expect(fromPng.image.endsWith('.webp')).toBe(true);
    expect(fromJpeg.image.endsWith('.jpg')).toBe(true);
    expect(fromWebp.image.endsWith('.webp')).toBe(true);

    for (const result of [fromPng, fromJpeg, fromWebp]) {
      const format = (await sharp(result.imagePath).metadata()).format;
      expect(['webp', 'jpeg']).toContain(format);
    }
    expect(resolveOutputMime('png')).toBe('image/webp');
    expect(resolveOutputMime('jpeg')).toBe('image/jpeg');
  });

  it('strips EXIF metadata from the stored files', async () => {
    const input = await makeImage(900, 900, 'jpeg', {
      exif: { IFD0: { Copyright: 'very-secret-copyright', Artist: 'private' } },
    });
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await processAndStoreProductImage(input);
    stored.push(result);

    expect((await sharp(result.imagePath).metadata()).exif).toBeUndefined();
    const thumbnailExif = (await sharp(result.thumbnailPath).metadata()).exif;
    expect(thumbnailExif).toBeUndefined();
  });

  it('writes distinct files for two uploads of the same source image', async () => {
    const buffer = await makeImage(500, 500, 'jpeg');
    const first = await processAndStoreProductImage(buffer);
    const second = await processAndStoreProductImage(buffer);
    stored.push(first, second);
    expect(first.image).not.toBe(second.image);
    expect(first.thumbnail).not.toBe(second.thumbnail);
  });

  it('refuses a requested output size above the hard 1200x1200 limit', async () => {
    await expect(
      processAndStoreProductImage(await makeImage(300, 300, 'jpeg'), {
        mainMaxWidth: 2000,
      }),
    ).rejects.toThrow(/exceed the hard limit/);
  });

  it('rejects non-image payloads before touching the filesystem', async () => {
    await expect(processAndStoreProductImage(Buffer.from('not an image at all'))).rejects.toThrow(
      /Unsupported or corrupt image/i,
    );
  });

  it('builds timestamped random file names with the right extension', () => {
    const name = buildFileName('image/webp', '-thumb');
    expect(name).toMatch(/^\d{13}-[a-f0-9]{16}-thumb\.webp$/);
    expect(() => buildFileName('image/gif')).toThrow(/Unsupported output mime/);
  });
});

describe('file lifecycle helpers', () => {
  it('maps public URLs back to file paths and refuses foreign paths', () => {
    const url = buildPublicUrl('1700000000000-aaaaaaaaaaaaaaaa.webp');
    // `path.join`, because the helper returns a native path: a literal `/` between
    // the directory and the file name only matches on POSIX.
    expect(publicUrlToPath(url)).toBe(
      path.join(getProductImageDir(), '1700000000000-aaaaaaaaaaaaaaaa.webp'),
    );
    expect(publicUrlToPath('https://evil.example/x.png')).toBeNull();
    expect(publicUrlToPath('/etc/passwd')).toBeNull();
    expect(publicUrlToPath('/uploads/products/../../escape.webp')).toBeNull();
    expect(publicUrlToPath('/uploads/other/file.webp')).toBeNull();
  });

  it('deletes main and thumbnail files, and tolerates already-missing files', async () => {
    const result = await processAndStoreProductImage(await makeImage(400, 400, 'jpeg'));
    await expect(fs.access(result.imagePath)).resolves.toBeUndefined();

    const removed = await removeImagesByUrl([result.image, result.thumbnail]);
    expect(removed).toBe(2);

    await expect(fs.access(result.imagePath)).rejects.toThrow();
    // Second call: nothing to do, no throw.
    await expect(removeImagesByUrl([result.image, result.thumbnail])).resolves.toBe(0);
  });

  it('sweeps orphaned files that no product references', async () => {
    const result = await processAndStoreProductImage(await makeImage(400, 400, 'jpeg'));
    const fileName = result.image.split('/').pop();
    const { removed } = await sweepOrphanedImages(new Set([fileName]));
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(fs.access(result.thumbnailPath)).rejects.toThrow();
    // Referenced file survives the sweep.
    await expect(fs.access(result.imagePath)).resolves.toBeUndefined();
    await removeImagesByUrl([result.image]);
  });
});
