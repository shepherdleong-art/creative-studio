import sharp from 'sharp';

const MIME_BY_SHARP_FORMAT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Force a full image decode before the upload route writes any bytes to disk.
 * Magic bytes alone are insufficient because truncated files can retain a
 * valid prefix while failing later in Sharp preprocessing.
 */
export async function validateUploadedImageBuffer(buffer: Buffer, expectedMime: string): Promise<boolean> {
  try {
    const result = await sharp(buffer, { failOn: 'error' }).toBuffer({ resolveWithObject: true });
    return result.info.width > 0
      && result.info.height > 0
      && MIME_BY_SHARP_FORMAT[result.info.format] === expectedMime;
  } catch {
    return false;
  }
}
