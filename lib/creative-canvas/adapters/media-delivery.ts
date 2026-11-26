/**
 * 画布素材交付（技术约定 C6）：通用实现由主工作台视频供应商共享，
 * 画布层先按模型预算准备上传副本，共享交付层负责 COS／URL 与 CanvasAdapterError 边界。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { dataRoot } from '../../data-root.ts';
import { preferReadableCosOrigin } from '../../cos-media.ts';
import { encodeImageWithinByteBudget } from '../../media-core/image-byte-budget.ts';
import {
  deliverVideoReferenceMedia,
  precheckVideoReferenceDeliveryMedia,
  prepareMiniMaxH3ReferenceImage,
  VIDEO_REFERENCE_DELIVERY_LIMITS,
  VideoReferenceMediaError,
} from '../../video-providers/reference-media.ts';
import { CanvasAdapterError } from './types.ts';
import type { CanvasMediaKind, CanvasReferenceRole } from '../types.ts';

export type CanvasDeliveryKind = Exclude<CanvasMediaKind, never>;

export interface CanvasDeliveryRequest {
  kind: CanvasDeliveryKind;
  absolutePath: string;
  mimeType: string;
  byteSize: number;
  durationSec: number | null;
  role: CanvasReferenceRole;
  /** true：必须走 COS 预签名 URL，禁止回退本机／公网地址。 */
  requireCos: boolean;
  preferCosOrigin?: boolean;
  /** 视频首帧／尾帧图：走视频压缩阈值，避免起点画质被压糊。 */
  isFrameImage: boolean;
  /** 已按模型限制生成的上传副本，禁止 COS 再次转码成模型不支持的格式。 */
  imageCompression?: false;
  imageBuffer?: Buffer<ArrayBuffer>;
}

export interface CanvasMediaDeliverer {
  readonly name: string;
  deliver(request: CanvasDeliveryRequest, signal?: AbortSignal): Promise<string>;
}

/** 各媒体类型的硬上限：模型级更严的限制写在能力表 inputs[].maxBytes／maxDurationSec。 */
export const CANVAS_DELIVERY_LIMITS = VIDEO_REFERENCE_DELIVERY_LIMITS;

export interface CanvasDeliveryPrecheckOptions {
  mimeTypes?: ReadonlyArray<string>;
  maxBytes?: number;
  maxDurationSec?: number | null;
}

interface CanvasDeliveryPreparationOptions extends CanvasDeliveryPrecheckOptions {
  modelAlias?: string;
  cropToAspectRatio?: string;
  outputImageMimeTypes?: readonly string[];
}

/** 交付前校验：类型、MIME、大小、时长。返回空数组表示可以交付。 */
export function precheckCanvasDeliveryMedia(
  request: Pick<CanvasDeliveryRequest, 'kind' | 'mimeType' | 'byteSize' | 'durationSec' | 'absolutePath'>,
  options: CanvasDeliveryPrecheckOptions = {},
): string[] {
  return precheckVideoReferenceDeliveryMedia(request, options);
}

/** Prepare an upload copy before enforcing the model's byte budget. */
export async function prepareCanvasDeliveryMedia(
  request: CanvasDeliveryRequest,
  options: CanvasDeliveryPreparationOptions = {},
  signal?: AbortSignal,
): Promise<{ request: CanvasDeliveryRequest; dispose: () => Promise<void> }> {
  signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? CANVAS_DELIVERY_LIMITS[request.kind].maxBytes;
  // 临时副本只用于 COS；本机 URL 必须继续引用长期保留的原文件。
  const canCompress = request.kind === 'image' && request.requireCos;
  const cropToAspectRatio = canCompress ? options.cropToAspectRatio : undefined;
  const problems = precheckCanvasDeliveryMedia(request, {
    ...options, ...(canCompress ? { maxBytes: Infinity } : {}),
  });
  if (problems.length) {
    throw new CanvasAdapterError('prepare', '未通过交付校验：' + problems.join('；') + '，任务未提交。', {
      code: 'media_precheck_failed',
    });
  }
  if (canCompress && options.modelAlias === 'minimax-h3') {
    return { request: await prepareMiniMaxH3CanvasImage(request, maxBytes, signal), dispose: async () => {} };
  }
  if (!cropToAspectRatio && (request.kind !== 'image' || request.byteSize <= maxBytes)) {
    // 模型收 JPEG/PNG 时保持已合规原图，避免通用 COS 压缩把透明 PNG 转成 WebP。
    const preserveFormat = request.kind === 'image' && request.requireCos && options.mimeTypes
      && !options.mimeTypes.includes('image/webp');
    return { request: preserveFormat ? { ...request, imageCompression: false } : request, dispose: async () => {} };
  }

  let temporaryPath: string | null = null;
  const dispose = async () => {
    if (!temporaryPath) return;
    await fs.promises.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    temporaryPath = null;
  };
  try {
    const bytes = await fs.promises.readFile(request.absolutePath);
    const metadata = await sharp(bytes).metadata();
    const allowedMime = options.outputImageMimeTypes ?? options.mimeTypes ?? CANVAS_DELIVERY_LIMITS.image.mimeTypes;
    // Preserve transparency with PNG when the model does not accept WebP (H3 / Wan).
    const mimeType = metadata.hasAlpha && allowedMime.includes('image/png')
      ? 'image/png' : allowedMime.includes('image/jpeg') ? 'image/jpeg' : request.mimeType;
    const { width, height } = metadata.autoOrient;
    const ratioUnits = cropToAspectRatio?.split(':').map(Number);
    const crop = ratioUnits ? centerCrop(width, height, ratioUnits) : null;
    const needsOrientation = ratioUnits !== undefined && (metadata.orientation ?? 1) !== 1;
    if (!crop && !needsOrientation && bytes.length <= maxBytes && allowedMime.includes(request.mimeType)) {
      return { request: { ...request, imageCompression: false }, dispose };
    }
    const image = crop ? await sharp(bytes).autoOrient().extract(crop).png().toBuffer() : bytes;
    const compressed = await encodeImageWithinByteBudget(image, mimeType,
      Math.max(crop?.width ?? width, crop?.height ?? height), maxBytes, signal, ratioUnits ? Math.max(...ratioUnits) : 1);
    const prepared = { ...request, mimeType, byteSize: compressed.length, imageCompression: false as const };
    const remainingProblems = precheckCanvasDeliveryMedia(prepared, options);
    if (remainingProblems.length) throw new Error('compressed image failed validation');
    const directory = path.join(dataRoot(), 'storage', 'tmp', 'canvas-media-delivery');
    await fs.promises.mkdir(directory, { recursive: true });
    temporaryPath = path.join(directory, randomUUID() + (mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg'));
    await fs.promises.writeFile(temporaryPath, compressed, { flag: 'wx' });
    signal?.throwIfAborted();
    return { request: { ...prepared, absolutePath: temporaryPath }, dispose };
  } catch {
    await dispose();
    signal?.throwIfAborted();
    if (cropToAspectRatio) {
      const label = request.isFrameImage ? '关键帧' : '参考图';
      throw new CanvasAdapterError('prepare', `无法按 ${cropToAspectRatio} 准备${label}，请检查素材尺寸，任务未提交。`, {
        code: request.isFrameImage ? 'frame_aspect_ratio_failed' : 'reference_aspect_ratio_failed',
      });
    }
    throw new CanvasAdapterError('prepare', '图片自动压缩失败，请更换素材后重试，任务未提交。', { code: 'image_compression_failed' });
  }
}

async function prepareMiniMaxH3CanvasImage(request: CanvasDeliveryRequest, maxBytes: number, signal?: AbortSignal): Promise<CanvasDeliveryRequest> {
  try {
    let mimeType = request.mimeType;
    if (mimeType === 'image/webp' || (mimeType === 'image/png' && request.byteSize > maxBytes)) {
      const { hasAlpha } = await sharp(request.absolutePath).metadata();
      mimeType = hasAlpha ? 'image/png' : 'image/jpeg';
    }
    const imageBuffer = await prepareMiniMaxH3ReferenceImage(request.absolutePath, mimeType, request.byteSize, maxBytes, signal);
    return {
      ...request,
      imageCompression: false,
      ...(imageBuffer ? { imageBuffer, mimeType, byteSize: imageBuffer.length } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof VideoReferenceMediaError) {
      throw new CanvasAdapterError('prepare', error.message, { code: error.code });
    }
    throw new CanvasAdapterError('prepare', '无法读取 MiniMax H3 参考图，请检查图片格式后重试。', { code: 'reference_preparation_failed' });
  }
}

function centerCrop(width: number, height: number, [ratioWidth, ratioHeight]: number[]) {
  const units = Math.floor(Math.min(width / ratioWidth, height / ratioHeight));
  const cropWidth = units * ratioWidth;
  const cropHeight = units * ratioHeight;
  if (!Number.isFinite(units) || cropWidth <= 0 || cropHeight <= 0) throw new Error('invalid crop aspect ratio');
  if (cropWidth === width && cropHeight === height) return null;
  return { left: Math.floor((width - cropWidth) / 2), top: Math.floor((height - cropHeight) / 2),
    width: cropWidth, height: cropHeight };
}

/** COS → 本机 URL 的默认交付实现（旧工作台已验证的通道）。 */
export function createDefaultCanvasDeliverer(): CanvasMediaDeliverer {
  return {
    name: 'cos-or-local-url',
    async deliver(request, signal) {
      try {
        const url = await deliverVideoReferenceMedia(request, signal);
        return request.preferCosOrigin && request.requireCos ? await preferReadableCosOrigin(url, signal) : url;
      } catch (error) {
        if (error instanceof VideoReferenceMediaError) {
          throw new CanvasAdapterError('prepare', error.message, { code: error.code });
        }
        throw error;
      }
    },
  };
}
