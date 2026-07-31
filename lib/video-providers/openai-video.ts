import {
  isPrivateOrLocalHttpUrl,
  resolvePublicImageUrlWithSource,
} from '../local-image-url.ts';
import { normalizeGatewayResultUrl, sanitizeGatewayMediaDiagnostic } from '../gateway-media-url.ts';
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
  url?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

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

export const openaiVideoAdapter: VideoProviderAdapter = {
  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/v1/videos`;

    // 网关的 images 字段映射到上游首帧/参考图。上游（腾讯等）只接受可访问的真实 URL；
    // 自动探测到的私网地址不可用时，要求用户显式配置对网关可达的公开地址。
    const imageResolution = resolvePublicImageUrlWithSource(request.sourceImagePath);
    if (
      !imageResolution
      || (imageResolution.source === 'network' && isPrivateOrLocalHttpUrl(imageResolution.url))
    ) {
      throw new Error(
        '视频首帧图片没有可供上游访问的公网 URL，请设置 CREATIVE_STUDIO_PUBLIC_BASE_URL 为网关可访问的地址后重试。',
      );
    }
    const imageRef = imageResolution.url;

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt || 'gentle camera movement, stable product detail',
      seconds: String(request.durationSec),
      images: [imageRef],
    };

    // 可灵 3.x 的智能分镜（multi_shot）：网关把 multi_shot / shot_type 透传到
    // 上游 ExtInfo.AdditionalParameters。与原生 kling 适配器一致，仅对 v3/3.0
    // 模型开启；网关协议里 multi_shot 是 JSON boolean（原生接口是字符串 "true"）。
    if (/v3|3\.0/i.test(request.model)) {
      body.multi_shot = true;
      body.shot_type = 'intelligence';
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

      const videoUrl = normalizeGatewayResultUrl(data.metadata?.url || data.url, cleanBase);
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
