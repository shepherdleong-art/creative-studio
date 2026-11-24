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
import {
  deliverVideoReferenceMedia,
  precheckVideoReferenceDeliveryMedia,
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
  options: CanvasDeliveryPrecheckOptions = {},
  signal?: AbortSignal,
): Promise<{ request: CanvasDeliveryRequest; dispose: () => Promise<void> }> {
  signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? CANVAS_DELIVERY_LIMITS[request.kind].maxBytes;
  // 临时副本只用于 COS；本机 URL 必须继续引用长期保留的原文件。
  const canCompress = request.kind === 'image' && request.requireCos;
  const problems = precheckCanvasDeliveryMedia(request, {
    ...options, ...(canCompress ? { maxBytes: Infinity } : {}),
  });
  if (problems.length) {
    throw new CanvasAdapterError('prepare', '未通过交付校验：' + problems.join('；') + '，任务未提交。', {
      code: 'media_precheck_failed',
    });
  }
  if (request.kind !== 'image' || request.byteSize <= maxBytes) {
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
    const allowedMime = options.mimeTypes ?? CANVAS_DELIVERY_LIMITS.image.mimeTypes;
    // Preserve transparency with PNG when the model does not accept WebP (H3 / Wan).
    const mimeType = metadata.hasAlpha && allowedMime.includes('image/png')
      ? 'image/png' : allowedMime.includes('image/jpeg') ? 'image/jpeg' : request.mimeType;
    const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    if (!longestEdge) throw new Error('missing dimensions');
    const targetBytes = Math.floor(maxBytes * 0.95);
    let compressed: Buffer | null = null;
    // Keep dimensions first; only reduce them if changing JPEG/WebP quality is insufficient.
    for (let scale = 0; scale <= 10 && !compressed; scale++) {
      const qualities = mimeType === 'image/png' ? [95] : scale === 0 ? [95, 90, 82] : [90];
      for (const quality of qualities) {
        signal?.throwIfAborted();
        let pipeline = sharp(bytes).rotate();
        if (scale > 0) {
          const maxDim = Math.max(1, Math.floor(longestEdge * 0.75 ** scale));
          pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
        }
        const candidate = await (mimeType === 'image/png'
          ? pipeline.png({ compressionLevel: 9 })
          : mimeType === 'image/webp' ? pipeline.webp({ quality }) : pipeline.jpeg({ quality, mozjpeg: true })
        ).toBuffer();
        if (candidate.length <= targetBytes) {
          compressed = candidate;
          break;
        }
      }
    }
    signal?.throwIfAborted();
    if (!compressed) throw new Error('image still exceeds budget');
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
    throw new CanvasAdapterError('prepare', '图片自动压缩失败，请更换素材后重试，任务未提交。', {
      code: 'image_compression_failed',
    });
  }
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
