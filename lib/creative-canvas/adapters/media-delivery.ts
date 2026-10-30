/**
 * 画布素材交付（技术约定 C6）：通用实现由主工作台视频供应商共享，
 * 这里只保留画布类型与 CanvasAdapterError 边界。
 */

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
  /** 视频首帧／尾帧图：走视频压缩阈值，避免起点画质被压糊。 */
  isFrameImage: boolean;
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

/** COS → 本机 URL 的默认交付实现（旧工作台已验证的通道）。 */
export function createDefaultCanvasDeliverer(): CanvasMediaDeliverer {
  return {
    name: 'cos-or-local-url',
    async deliver(request, signal) {
      try {
        return await deliverVideoReferenceMedia(request, signal);
      } catch (error) {
        if (error instanceof VideoReferenceMediaError) {
          throw new CanvasAdapterError('prepare', error.message, { code: error.code });
        }
        throw error;
      }
    },
  };
}
