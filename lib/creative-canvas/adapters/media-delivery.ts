/**
 * 画布素材交付（技术约定 C6）。
 *
 * 把「素材准备」从「单次生成 POST」里拆出来：prepare 只负责把本地素材变成上游可访问的
 * 交付地址（COS 预签名 URL 或本机 URL），submit 才发一次生成请求。
 * 交付层可以注入替换，测试用假交付捕获请求，不访问真实 COS。
 *
 * 红线：七牛渠道与公司尾帧必须走 COS 预签名 URL，缺配置或上传失败时在 POST 前 fail closed。
 */

import {
  getCosVideoCompressOptions,
  isCosMediaConfigured,
  tryUploadToCosAndSign,
} from '../../cos-media.ts';
import { isPrivateOrLocalHttpUrl, resolvePublicImageUrlWithSource } from '../../local-image-url.ts';
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
export const CANVAS_DELIVERY_LIMITS: Record<CanvasDeliveryKind, {
  mimeTypes: ReadonlyArray<string>;
  maxBytes: number;
  maxDurationSec: number | null;
}> = {
  image: { mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 30 * 1024 * 1024, maxDurationSec: null },
  video: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 200 * 1024 * 1024, maxDurationSec: 15 },
  audio: { mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4'], maxBytes: 15 * 1024 * 1024, maxDurationSec: 15 },
};

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
  const limits = CANVAS_DELIVERY_LIMITS[request.kind];
  const problems: string[] = [];
  const allowedMime = options.mimeTypes ?? limits.mimeTypes;
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const maxDurationSec = options.maxDurationSec === undefined ? limits.maxDurationSec : options.maxDurationSec;

  if (!allowedMime.includes(request.mimeType)) {
    problems.push(`格式不支持：${request.mimeType}（允许 ${allowedMime.join('、')}）`);
  }
  if (request.byteSize > maxBytes) {
    problems.push(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限`);
  }
  if (maxDurationSec !== null && request.durationSec !== null && request.durationSec > maxDurationSec) {
    problems.push(`时长 ${request.durationSec.toFixed(1)}s 超过 ${maxDurationSec}s 上限`);
  }
  if (!request.absolutePath) {
    problems.push('素材文件路径缺失');
  }
  return problems;
}

/** COS → 本机 URL 的默认交付实现（旧工作台已验证的通道）。 */
export function createDefaultCanvasDeliverer(): CanvasMediaDeliverer {
  return {
    name: 'cos-or-local-url',
    async deliver(request) {
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
            throw new CanvasAdapterError(
              'prepare',
              `素材上传 COS 失败，任务未提交：${error instanceof Error ? error.message : String(error)}`,
              { code: 'cos_upload_failed' },
            );
          }
        }
      } else if (request.requireCos) {
        throw new CanvasAdapterError(
          'prepare',
          '该渠道要求参考素材走 COS 预签名 URL，但未配置 CREATIVE_STUDIO_COS_*，任务未提交。',
          { code: 'cos_not_configured' },
        );
      }

      if (request.requireCos) {
        throw new CanvasAdapterError('prepare', '素材上传 COS 未返回有效地址，任务未提交。', { code: 'cos_upload_failed' });
      }
      if (request.kind !== 'image') {
        // 视频／音频参考没有本机 URL 回退通道：缺 COS 直接 fail closed
        throw new CanvasAdapterError(
          'prepare',
          `${request.kind === 'video' ? '视频' : '音频'}参考必须经 COS 交付，未配置 CREATIVE_STUDIO_COS_* 或上传失败，任务未提交。`,
          { code: 'cos_required_for_media' },
        );
      }

      const resolution = resolvePublicImageUrlWithSource(request.absolutePath);
      if (!resolution || (resolution.source === 'network' && isPrivateOrLocalHttpUrl(resolution.url))) {
        throw new CanvasAdapterError(
          'prepare',
          '素材没有可供上游访问的公网 URL：请配置 CREATIVE_STUDIO_COS_* 走 COS 中转，或设置 CREATIVE_STUDIO_PUBLIC_BASE_URL。',
          { code: 'public_url_unavailable' },
        );
      }
      return resolution.url;
    },
  };
}
