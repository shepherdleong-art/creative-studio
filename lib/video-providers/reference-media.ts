import fs from 'node:fs';
import sharp from 'sharp';
import { probeDurationSec, probeVideoMedia } from '../ffmpeg.ts';
import {
  getCosVideoCompressOptions,
  isCosMediaConfigured,
  tryUploadToCosAndSign,
} from '../cos-media.ts';
import { isPrivateOrLocalHttpUrl, resolvePublicImageUrlWithSource } from '../local-image-url.ts';
import { SEEDANCE_25 } from './seedance-contract.ts';

export type VideoReferenceMediaKind = 'image' | 'video' | 'audio';

export interface VideoReferenceMediaInput {
  kind: VideoReferenceMediaKind;
  absolutePath: string | null;
  mimeType: string;
  byteSize: number | null;
  durationSec: number | null;
}

export const VIDEO_REFERENCE_DELIVERY_LIMITS: Record<VideoReferenceMediaKind, {
  mimeTypes: ReadonlyArray<string>;
  maxBytes: number;
  maxDurationSec: number | null;
}> = {
  image: { mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 30 * 1024 * 1024, maxDurationSec: null },
  video: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 200 * 1024 * 1024, maxDurationSec: 15 },
  audio: { mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4'], maxBytes: 15 * 1024 * 1024, maxDurationSec: 15 },
};

export interface VideoReferenceDeliveryPrecheckOptions {
  mimeTypes?: ReadonlyArray<string>;
  maxBytes?: number;
  maxDurationSec?: number | null;
}

/** Shared type/size/duration checks; model-specific limits can tighten the defaults. */
export function precheckVideoReferenceDeliveryMedia(
  request: Pick<VideoReferenceMediaInput, 'kind' | 'mimeType' | 'byteSize' | 'durationSec' | 'absolutePath'>,
  options: VideoReferenceDeliveryPrecheckOptions = {},
): string[] {
  const limits = VIDEO_REFERENCE_DELIVERY_LIMITS[request.kind];
  const problems: string[] = [];
  const allowedMime = options.mimeTypes ?? limits.mimeTypes;
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const maxDurationSec = options.maxDurationSec === undefined ? limits.maxDurationSec : options.maxDurationSec;
  if (!allowedMime.includes(request.mimeType)) {
    problems.push(`格式不支持：${request.mimeType}（允许 ${allowedMime.join('、')}）`);
  }
  if ((request.byteSize ?? Infinity) > maxBytes) {
    problems.push(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`);
  }
  if (maxDurationSec !== null && request.durationSec !== null && request.durationSec > maxDurationSec) {
    problems.push(`时长 ${request.durationSec.toFixed(1)}s 超过 ${maxDurationSec}s 上限`);
  }
  if (!request.absolutePath) problems.push('素材文件路径缺失');
  return problems;
}

/** Probe missing duration and enforce the additional Seedance 2.5 media contract. */
export async function precheckSeedanceReferenceMedia(input: VideoReferenceMediaInput, model: string): Promise<string[]> {
  if (!input.absolutePath) return [];
  const problems: string[] = [];
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) {
      problems.push('宽高须为 300–6000 像素，宽高比须在 0.4–2.5 之间');
    }
  };
  if (input.kind !== 'image' && (input.durationSec === null || !Number.isFinite(input.durationSec))) {
    const duration = await probeDurationSec(input.absolutePath);
    if (!Number.isFinite(duration) || duration <= 0) problems.push('无法探测素材时长');
    else input.durationSec = duration;
  }
  if (model === SEEDANCE_25) {
    if (input.kind === 'image') {
      const metadata = await sharp(input.absolutePath).metadata().catch(() => probeVideoMedia(input.absolutePath!));
      dimensions(metadata.width ?? 0, metadata.height ?? 0);
      if ((input.byteSize ?? Infinity) >= 30 * 1024 * 1024) problems.push('图片须小于 30 MB');
    } else if (input.kind === 'video') {
      const probe = await probeVideoMedia(input.absolutePath);
      dimensions(probe.width, probe.height);
      const pixels = probe.width * probe.height;
      if (pixels < 407696 || pixels > 8295044) problems.push('视频总像素超出允许范围');
      if (probe.fps < 24 || probe.fps > 60) problems.push('视频帧率须在 24–60 FPS 之间');
      if (!['h264', 'hevc'].includes(probe.videoCodec ?? '')) problems.push('视频须采用 H.264 或 H.265 编码');
      if (probe.hasAudio && !['aac', 'mp3'].includes(probe.audioCodec ?? '')
        && !(input.mimeType === 'video/quicktime' && probe.audioCodec?.startsWith('pcm_'))) problems.push('视频音轨编码不支持');
    }
  }
  return problems;
}

export interface VideoReferenceDeliveryRequest extends VideoReferenceMediaInput {
  absolutePath: string;
  byteSize: number;
  requireCos: boolean;
  isFrameImage: boolean;
  imageFallback?: 'public-url' | 'data-url';
}

export class VideoReferenceMediaError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'VideoReferenceMediaError';
    this.code = code;
  }
}

/** Deliver local reference media without persisting temporary signed/data URLs. */
export async function deliverVideoReferenceMedia(
  request: VideoReferenceDeliveryRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const cosConfigured = isCosMediaConfigured();
  if (cosConfigured) {
    try {
      const signed = await tryUploadToCosAndSign(
        request.absolutePath,
        request.mimeType,
        request.kind === 'image' && request.isFrameImage ? getCosVideoCompressOptions() : undefined,
      );
      if (signed) return signed;
    } catch (error) {
      if (request.requireCos) {
        throw new VideoReferenceMediaError(
          `素材上传 COS 失败，任务未提交：${error instanceof Error ? error.message : String(error)}`,
          'cos_upload_failed',
        );
      }
    }
  } else if (request.requireCos) {
    throw new VideoReferenceMediaError(
      '该渠道要求参考素材走 COS 预签名 URL，但未配置 CREATIVE_STUDIO_COS_*，任务未提交。',
      'cos_not_configured',
    );
  }

  if (request.requireCos) {
    throw new VideoReferenceMediaError('素材上传 COS 未返回有效地址，任务未提交。', 'cos_upload_failed');
  }
  if (request.kind !== 'image') {
    throw new VideoReferenceMediaError(
      `${request.kind === 'video' ? '视频' : '音频'}参考必须经 COS 交付，未配置 CREATIVE_STUDIO_COS_* 或上传失败，任务未提交。`,
      'cos_required_for_media',
    );
  }
  if (request.imageFallback === 'data-url') {
    return `data:${request.mimeType};base64,${fs.readFileSync(request.absolutePath).toString('base64')}`;
  }
  const resolution = resolvePublicImageUrlWithSource(request.absolutePath);
  if (!resolution || (resolution.source === 'network' && isPrivateOrLocalHttpUrl(resolution.url))) {
    throw new VideoReferenceMediaError(
      '素材没有可供上游访问的公网 URL：请配置 CREATIVE_STUDIO_COS_* 走 COS 中转，或设置 CREATIVE_STUDIO_PUBLIC_BASE_URL。',
      'public_url_unavailable',
    );
  }
  return resolution.url;
}
