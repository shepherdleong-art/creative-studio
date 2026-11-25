export const QINIU_KLING_4_MODEL = 'qiniuyun/kling-4.0';
export const QINIU_KLING_4_PROVIDER_ID = 'company-qiniuyun-kling-4-0';
export const QINIU_KLING_4_PROVIDER_NAME = '公司七牛可灵 4.0';
export const QINIU_KLING_4_RESOLUTIONS = ['720p', '1080p'] as const;
export const QINIU_KLING_4_DEFAULT_RESOLUTION = QINIU_KLING_4_RESOLUTIONS[0];
export const QINIU_KLING_4_PROJECT_RESOLUTION = '1080p';
export const QINIU_KLING_4_MAX_MIDDLE_FRAMES = 8;
export const QINIU_KLING_4_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const QINIU_KLING_4_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const QINIU_KLING_4_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export const QINIU_KLING_4_CANVAS_ASPECT_RATIOS = [...QINIU_KLING_4_ASPECT_RATIOS, '4:3', '3:4', '21:9', 'adaptive'] as const;

export function supportsQiniuKling4Modes(providerType: string, model: string): boolean {
  return providerType === 'openai-video' && model === QINIU_KLING_4_MODEL;
}

export function validateQiniuKling4MiddleFrames(frames: readonly {
  id: string; kind: string; mimeType: string; byteSize: number;
}[]): string | null {
  if (frames.length < 1 || frames.length > QINIU_KLING_4_MAX_MIDDLE_FRAMES) {
    return `请添加 1–${QINIU_KLING_4_MAX_MIDDLE_FRAMES} 张中间帧`;
  }
  if (new Set(frames.map(frame => frame.id)).size !== frames.length) return '中间帧素材不能重复';
  if (frames.some(frame => frame.kind !== 'image'
    || !QINIU_KLING_4_IMAGE_MIME_TYPES.some(mime => mime === frame.mimeType)
    || !Number.isFinite(frame.byteSize) || frame.byteSize <= 0 || frame.byteSize > QINIU_KLING_4_IMAGE_MAX_BYTES)) {
    return '中间帧须为 10 MiB 以内的 PNG 或 JPEG 图片';
  }
  return null;
}

function qiniuKling4OutputFields(durationSec: number, requestedResolution?: string | null) {
  const resolution = QINIU_KLING_4_RESOLUTIONS.find(tier => tier === (requestedResolution ?? QINIU_KLING_4_DEFAULT_RESOLUTION));
  if (!resolution) throw new Error(`输出清晰度 ${requestedResolution} 不受支持`);
  return { seconds: String(durationSec), duration: durationSec, resolution };
}

export function qiniuKling4ReferenceFields(
  references: readonly { kind: 'image' | 'video' | 'audio'; url: string }[],
  durationSec: number,
  aspectRatio: string,
  resolution?: string | null,
) {
  const imageUrls = references.filter(reference => reference.kind === 'image').map(reference => reference.url);
  const videoUrls = references.filter(reference => reference.kind === 'video').map(reference => reference.url);
  return {
    ...qiniuKling4OutputFields(durationSec, resolution),
    aspect_ratio: aspectRatio,
    ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    ...(videoUrls.length ? { video_urls: videoUrls } : {}),
  };
}

/** 七牛关键帧画幅随首帧。网关的 size 会触发显式比例校验，关键帧请求只携带 resolution。 */
export function qiniuKling4FirstFrameFields(
  firstFrameUrl: string,
  durationSec: number,
  middleFrameUrls: readonly string[] = [],
  resolution?: string | null,
) {
  return {
    ...qiniuKling4OutputFields(durationSec, resolution),
    images: [firstFrameUrl],
    start_image_url: firstFrameUrl,
    ...(middleFrameUrls.length ? { middle_image_urls: middleFrameUrls } : {}),
  };
}
