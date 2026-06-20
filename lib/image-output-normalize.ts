import sharp from 'sharp';

export interface ImageTargetSize {
  width: number;
  height: number;
}

export interface NormalizedGeneratedImage {
  imageBuffer: Buffer;
  width: number;
  height: number;
  changed: boolean;
  reason?: string;
}

export function parseImageTargetSize(size: string | null | undefined): ImageTargetSize | null {
  if (!size || size === 'auto') return null;

  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

export async function normalizeGeneratedImageToSize(
  imageBuffer: Buffer,
  size: string | null | undefined,
): Promise<NormalizedGeneratedImage> {
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  const target = parseImageTargetSize(size);

  if (!target) {
    return {
      imageBuffer,
      width: sourceWidth,
      height: sourceHeight,
      changed: false,
    };
  }

  if (sourceWidth === target.width && sourceHeight === target.height) {
    return {
      imageBuffer,
      width: sourceWidth,
      height: sourceHeight,
      changed: false,
    };
  }

  const normalizedBuffer = await sharp(imageBuffer)
    .resize(target.width, target.height, {
      fit: 'cover',
      position: 'center',
    })
    .png()
    .toBuffer();

  return {
    imageBuffer: normalizedBuffer,
    width: target.width,
    height: target.height,
    changed: true,
    reason: `${sourceWidth}x${sourceHeight} -> ${target.width}x${target.height}`,
  };
}
