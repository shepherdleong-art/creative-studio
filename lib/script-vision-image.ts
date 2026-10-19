import sharp from 'sharp';

/** Script generation needs visual meaning, not the multi-megabyte source pixels. */
export const SCRIPT_VISION_IMAGE_MAX_SIDE = 1024;
export const SCRIPT_VISION_IMAGE_MAX_BYTES = 384 * 1024;
export const SCRIPT_VISION_TOTAL_RAW_BYTES = 4 * 1024 * 1024;
export const SCRIPT_VISION_TOTAL_BASE64_CHARACTERS = Math.ceil(SCRIPT_VISION_TOTAL_RAW_BYTES / 3) * 4;

export interface PrepareScriptVisionImageInput {
  imageBuffer: Buffer;
  mimeType: string;
  maxBytes?: number;
}

export interface PreparedScriptVisionImage {
  imageBuffer: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  originalSizeBytes: number;
  processedSizeBytes: number;
}

const ENCODE_ATTEMPTS = [
  { maxSide: 1024, quality: 78 },
  { maxSide: 1024, quality: 68 },
  { maxSide: 896, quality: 72 },
  { maxSide: 768, quality: 66 },
  { maxSide: 640, quality: 58 },
  { maxSide: 512, quality: 52 },
  { maxSide: 384, quality: 45 },
] as const;

export async function prepareScriptVisionImage(
  input: PrepareScriptVisionImageInput,
): Promise<PreparedScriptVisionImage> {
  const maxBytes = Math.max(64 * 1024, Math.floor(input.maxBytes ?? SCRIPT_VISION_IMAGE_MAX_BYTES));
  let smallest: { data: Buffer; width: number; height: number } | null = null;

  for (const attempt of ENCODE_ATTEMPTS) {
    const { data, info } = await sharp(input.imageBuffer, { failOn: 'error' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: attempt.maxSide,
        height: attempt.maxSide,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });

    const candidate = { data, width: info.width, height: info.height };
    if (!smallest || data.length < smallest.data.length) smallest = candidate;
    if (data.length <= maxBytes) {
      return {
        imageBuffer: data,
        mimeType: 'image/jpeg',
        width: info.width,
        height: info.height,
        originalSizeBytes: input.imageBuffer.length,
        processedSizeBytes: data.length,
      };
    }
  }

  throw new Error(
    `分镜图片压缩后仍超过请求上限（${smallest?.data.length || 0} > ${maxBytes} bytes）`,
  );
}
