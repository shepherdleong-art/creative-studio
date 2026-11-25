import fs from 'node:fs';
import sharp from 'sharp';
import { probeDurationSec, probeVideoMedia } from '../ffmpeg.ts';
import {
  getCosVideoCompressOptions,
  isCosMediaConfigured,
  tryUploadBufferToCosAndSign,
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
  imageBuffer?: Buffer<ArrayBuffer>;
}

const SEEDANCE_REFERENCE_MIN_SIDE = 300;
const SEEDANCE_REFERENCE_MAX_SIDE = 6000;
const SEEDANCE_REFERENCE_MIN_RATIO = 0.4;

function validSeedanceReferenceDimensions(width: number, height: number): boolean {
  return Math.min(width, height) >= SEEDANCE_REFERENCE_MIN_SIDE
    && Math.max(width, height) <= SEEDANCE_REFERENCE_MAX_SIDE
    && Math.min(width, height) >= Math.max(width, height) * SEEDANCE_REFERENCE_MIN_RATIO;
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

/** Prepare a delivery-only copy of an out-of-range frozen source image. */
export async function prepareSeedanceSourceReference(file: string, bytes: number): Promise<Buffer<ArrayBuffer> | undefined> {
  const image = sharp(file);
  const { autoOrient: { width, height } } = await image.metadata();
  const byteLimit = VIDEO_REFERENCE_DELIVERY_LIMITS.image.maxBytes;
  if (validSeedanceReferenceDimensions(width, height) && bytes < byteLimit) return;

  const maxSide = bytes >= byteLimit ? 4096 : SEEDANCE_REFERENCE_MAX_SIDE;
  const scale = Math.min(maxSide / Math.max(width, height), Math.max(1, SEEDANCE_REFERENCE_MIN_SIDE / Math.min(width, height)));
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const buffer = await image.autoOrient().flatten({ background: '#fff' }).resize({
    width: Math.max(SEEDANCE_REFERENCE_MIN_SIDE, scaledWidth, Math.ceil(scaledHeight * SEEDANCE_REFERENCE_MIN_RATIO)),
    height: Math.max(SEEDANCE_REFERENCE_MIN_SIDE, scaledHeight, Math.ceil(scaledWidth * SEEDANCE_REFERENCE_MIN_RATIO)),
    fit: 'contain',
    background: '#fff',
  }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return buffer as Buffer<ArrayBuffer>;
}

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
    if (!validSeedanceReferenceDimensions(width, height)) {
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
      const metadata = await sharp(input.imageBuffer ?? input.absolutePath).metadata().catch(() => probeVideoMedia(input.absolutePath!));
      dimensions(metadata.width ?? 0, metadata.height ?? 0);
      if ((input.byteSize ?? Infinity) >= VIDEO_REFERENCE_DELIVERY_LIMITS.image.maxBytes) problems.push('图片须小于 30 MB');
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
  /** 上传副本已经压缩并校验；保留其格式与字节。 */
  imageCompression?: false;
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
      const signed = request.imageBuffer
        ? await tryUploadBufferToCosAndSign(request.imageBuffer, request.mimeType, { compress: false })
        : await tryUploadToCosAndSign(
          request.absolutePath,
          request.mimeType,
          request.imageCompression === false ? { compress: false }
            : request.kind === 'image' && request.isFrameImage ? getCosVideoCompressOptions() : undefined,
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
    const buffer = request.imageBuffer ?? fs.readFileSync(request.absolutePath);
    return `data:${request.mimeType};base64,${buffer.toString('base64')}`;
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
