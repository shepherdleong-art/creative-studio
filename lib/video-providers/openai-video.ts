import sharp from 'sharp';
import {
  isPrivateOrLocalHttpUrl,
  resolvePublicImageUrlWithSource,
} from '../local-image-url.ts';
import { isCosMediaConfigured, tryUploadToCosAndSign } from '../cos-media.ts';
import { normalizeGatewayResultUrl, sanitizeGatewayMediaDiagnostic } from '../gateway-media-url.ts';
import { companyVideoCapsForModel, snapCompanyVideoSize } from '../company-gateway-size.ts';
import type { VideoProviderAdapter, SubmitVideoRequest, SubmitVideoResult, PollVideoResult } from './types';

/**
 * OpenAI-style video API adapter (Sora 2 标准字段），适用于 New API 一类的
 * 统一中转网关：POST /v1/videos 提交、GET /v1/videos/<id> 轮询，
 * 完成后从 metadata.url 取成片地址。可灵、Seedance 等模型经网关转发时都走这个协议。
 */

type GatewayVideoResponse = {
  id: string;
  status?: string; // queued / processing / completed / failed
  progress?: number;
  metadata?: {
    url?: string;
  };
  output?: { url?: string };
  video?: { url?: string };
  result?: { video_url?: string; url?: string };
  video_url?: string;
  url?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

// 产物 URL 的兼容结构（见《小林生影_AIGC模型调用文档》§4.2）：
// metadata.url / output.url / video.url / result.video_url / result.url / video_url / url
function extractVideoUrl(data: GatewayVideoResponse): string | undefined {
  return (
    data.metadata?.url ??
    data.output?.url ??
    data.video?.url ??
    data.result?.video_url ??
    data.result?.url ??
    data.video_url ??
    data.url ??
    undefined
  );
}

function normalizeGatewayStatus(raw: string | undefined): PollVideoResult['status'] {
  if (!raw) return 'unknown';
  switch (raw.toLowerCase()) {
    case 'queued': return 'pending';
    case 'processing': return 'processing';
    case 'completed': return 'succeeded';
    case 'failed':
    case 'expired':
    case 'cancelled': return 'failed';
    default: return 'unknown';
  }
}

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;

function sanitizeGatewayRawResponse(value: unknown, apiKey: string): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized) return null;
  return parseSanitizedGatewayResponse(serialized, apiKey);
}

function parseSanitizedGatewayResponse(value: string, apiKey: string): unknown {
  const sanitized = sanitizeGatewayMediaDiagnostic(value, apiKey);
  try {
    return JSON.parse(sanitized);
  } catch {
    return sanitized;
  }
}

/** 读首帧图宽高；文件缺失或无法解析时返回 null（调用方省略 size，由网关兜底） */
async function probeImageDimensions(imagePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(imagePath).metadata();
    if (metadata.width && metadata.height) return { width: metadata.width, height: metadata.height };
    return null;
  } catch {
    return null;
  }
}

export const openaiVideoAdapter: VideoProviderAdapter = {
  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/v1/videos`;

    // 网关的 images 字段映射到上游首帧/参考图。上游（腾讯等）只接受可访问的真实 URL。
    // 优先上传腾讯云 COS 返回 24h 预签名 URL（配置 CREATIVE_STUDIO_COS_* 时）；
    // 否则回退本机 HTTP URL——自动探测到的私网地址不可用时，要求用户显式配置公开地址。
    let imageRef: string | null = null;
    if (isCosMediaConfigured()) {
      try {
        imageRef = await tryUploadToCosAndSign(request.sourceImagePath);
      } catch (error) {
        console.warn('[cos-media] 首帧图上传 COS 失败，回退本机 URL：', error instanceof Error ? error.message : error);
      }
    }
    if (!imageRef) {
      const imageResolution = resolvePublicImageUrlWithSource(request.sourceImagePath);
      if (
        !imageResolution
        || (imageResolution.source === 'network' && isPrivateOrLocalHttpUrl(imageResolution.url))
      ) {
        throw new Error(
          '视频首帧图片没有可供上游访问的公网 URL，请设置 CREATIVE_STUDIO_PUBLIC_BASE_URL 为网关可访问的地址，或配置 CREATIVE_STUDIO_COS_* 使用腾讯云 COS 中转后重试。',
        );
      }
      imageRef = imageResolution.url;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt || 'gentle camera movement, stable product detail',
      seconds: String(request.durationSec),
      images: [imageRef],
    };

    // 可灵 3.x 的智能分镜（multi_shot）：网关把 multi_shot / shot_type 透传到
    // 上游 ExtInfo.AdditionalParameters。与原生 kling 适配器一致，仅对 v3/3.0
    // 模型开启；网关协议里 multi_shot 是 JSON boolean（原生接口是字符串 "true"）。
    // Kling 3.0 Omni 不支持智能分镜，不能传这两个字段（公司文档 §5.1）。
    if (/v3|3\.0/i.test(request.model) && !/omni/i.test(request.model)) {
      body.multi_shot = true;
      body.shot_type = 'intelligence';
    }

    // 公司网关要求 response_format=mp4，size 取文档白名单内的像素组合
    // （按首帧图比例吸附，档位偏好 1K）。首帧尺寸读不出来时省略 size。
    const companyCaps = companyVideoCapsForModel(request.model);
    if (companyCaps) {
      body.response_format = 'mp4';
      const sourceDims = await probeImageDimensions(request.sourceImagePath);
      const snappedSize = sourceDims
        ? snapCompanyVideoSize(sourceDims.width, sourceDims.height, companyCaps)
        : null;
      if (snappedSize) body.size = snappedSize;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = sanitizeGatewayMediaDiagnostic(await res.text(), apiKey);
        throw new Error(`Video gateway submit error ${res.status}: ${errorText.slice(0, 500)}`);
      }

      const data = (await res.json()) as GatewayVideoResponse;

      return {
        providerTaskId: data.id,
        rawResponse: sanitizeGatewayRawResponse(data, apiKey),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },

  async poll(
    taskId: string,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<PollVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/v1/videos/${taskId}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        const sanitizedErrorText = sanitizeGatewayMediaDiagnostic(errorText, apiKey);
        return {
          status: 'unknown',
          errorMessage: `Video gateway poll error ${res.status}: ${sanitizedErrorText.slice(0, 500)}`,
          rawResponse: parseSanitizedGatewayResponse(errorText, apiKey),
        };
      }

      const data = (await res.json()) as GatewayVideoResponse;
      const status = normalizeGatewayStatus(data.status);

      if (status === 'failed') {
        return {
          status,
          errorMessage: sanitizeGatewayMediaDiagnostic(data.error?.message || `Task ${data.status}`, apiKey),
          rawResponse: sanitizeGatewayRawResponse(data, apiKey),
        };
      }

      // 公司网关完成态常常不带产物 URL（文档 §5.3）：回退到 /content 端点下载。
      // 必须用提交时返回的原始任务 id 拼地址——轮询响应里的 id 可能丢失
      // model_id，LiteLLM 代理凭它会路由到错误的默认上游。
      const rawUrl = extractVideoUrl(data)
        ?? (status === 'succeeded' ? `${cleanBase}/v1/videos/${taskId}/content` : undefined);
      const videoUrl = normalizeGatewayResultUrl(rawUrl, cleanBase);
      return {
        status,
        videoUrl: status === 'succeeded' ? videoUrl : undefined,
        rawResponse: sanitizeGatewayRawResponse(data, apiKey),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
