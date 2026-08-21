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

/**
 * 原生像素交付（nativeDelivery 公司模型）：只按目标比例（由名义格子尺寸推出）
 * 居中裁切，绝不缩放。源图比例与目标一致时原样返回；不一致时裁到该比例下的
 * 最大内接矩形（如 image2-medium 的 1K 3:4 实返 1024x1376，裁齐到 1024x1366；
 * 2K 3:4 实返 1920x2560 已是精确 3:4，原样交付白赚像素）。
 */
export async function normalizeGeneratedImageToNativeRatio(
  imageBuffer: Buffer,
  ratioOf: string | null | undefined,
): Promise<NormalizedGeneratedImage> {
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  const target = parseImageTargetSize(ratioOf);

  if (!target || sourceWidth <= 0 || sourceHeight <= 0) {
    return { imageBuffer, width: sourceWidth, height: sourceHeight, changed: false };
  }

  const targetRatio = target.width / target.height;
  const sourceRatio = sourceWidth / sourceHeight;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceRatio > targetRatio) {
    cropWidth = Math.round(sourceHeight * targetRatio);
  } else if (sourceRatio < targetRatio) {
    cropHeight = Math.round(sourceWidth / targetRatio);
  }

  if (cropWidth === sourceWidth && cropHeight === sourceHeight) {
    return { imageBuffer, width: sourceWidth, height: sourceHeight, changed: false };
  }

  const croppedBuffer = await sharp(imageBuffer)
    .extract({
      left: Math.floor((sourceWidth - cropWidth) / 2),
      top: Math.floor((sourceHeight - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    })
    .png()
    .toBuffer();

  return {
    imageBuffer: croppedBuffer,
    width: cropWidth,
    height: cropHeight,
    changed: true,
    reason: `${sourceWidth}x${sourceHeight} -> ${cropWidth}x${cropHeight}（仅裁齐比例，未缩放）`,
  };
}
