import sharp from 'sharp';
import {
  isPrivateOrLocalHttpUrl,
  resolvePublicImageUrlWithSource,
} from '../local-image-url.ts';
import {
  getCosVideoCompressOptions,
  isCosMediaConfigured,
  tryUploadToCosAndSign,
} from '../cos-media.ts';
import { normalizeGatewayResultUrl, sanitizeGatewayMediaDiagnostic } from '../gateway-media-url.ts';
import { companyVideoCapsForModel, snapCompanyVideoSize, snapCompanyVideoAspectRatio } from '../company-gateway-size.ts';
import {
  assertCompanyTailFrameTransport,
  companyGatewayTailFrameCapability,
  uploadCompanyTailFrameImages,
} from '../company-gateway-tail-frame.ts';
import { shouldInjectCompanyKlingMultiShot } from '../video-multi-shot.ts';
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
  tailFrameCapability(model) {
    return companyGatewayTailFrameCapability(model);
  },

  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/v1/videos`;

    const hasTailImagePath = request.tailImagePath !== undefined;
    const hasTailMimeType = request.tailMimeType !== undefined;
    if (hasTailImagePath !== hasTailMimeType) {
      throw new Error('OpenAI-video tail frame requires tailImagePath and tailMimeType together');
    }
    const tailCapability = hasTailImagePath ? companyGatewayTailFrameCapability(request.model) : null;
    if (tailCapability && !tailCapability.supported) {
      throw new Error(`模型 ${request.model} 不支持首尾帧（不在公司网关尾帧已核验别名内），请移除尾帧图或更换模型`);
    }

    // 网关的 images 字段映射到上游首帧/参考图。上游（腾讯等）只接受可访问的真实 URL。
    // 优先上传腾讯云 COS 返回 24h 预签名 URL（配置 CREATIVE_STUDIO_COS_* 时）；
    // 否则回退本机 HTTP URL——自动探测到的私网地址不可用时，要求用户显式配置公开地址。
    let imageRef: string | null = null;
    let tailImageRef: string | null = null;
    if (hasTailImagePath) {
      // 公司尾帧（D9 硬门禁）：只允许本机回环 LiteLLM + COS 预签名 URL，
      // 首帧尾帧都走 COS，禁止回退本机/公网 URL；门禁或上传失败时不得发出 POST。
      await assertCompanyTailFrameTransport(cleanBase);
      [imageRef, tailImageRef] = await uploadCompanyTailFrameImages(
        request.sourceImagePath,
        request.tailImagePath!,
        request.tailMimeType,
      );
    } else if (isCosMediaConfigured()) {
      try {
        // 视频首帧默认 >4.8MB 才压缩（质量 95）：腾讯首帧限 10M、尾帧限 5M，
        // 阈值以下原样上传，不动视频生成起点画质。
        imageRef = await tryUploadToCosAndSign(
          request.sourceImagePath,
          undefined,
          getCosVideoCompressOptions(),
        );
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

    // 公司尾帧合同（2026-08-17 免费字段探测 + 真实任务双重验证）：
    // - 可灵（company-gateway-kling）：images 只放首帧，尾帧走腾讯原生
    //   LastFrameUrl；images[1] 会被下游当参考图且比例落回 16:9 默认值。
    // - 公司 Seedance（company-gateway-seedance）：images[1] 双图，
    //   比例与末帧收束均已实测正确。
    const tailProtocol = tailImageRef ? tailCapability?.protocol : undefined;
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt || 'gentle camera movement, stable product detail',
      seconds: String(request.durationSec),
      images: tailProtocol === 'company-gateway-seedance' ? [imageRef, tailImageRef] : [imageRef],
    };
    if (tailProtocol === 'company-gateway-kling') {
      body.LastFrameUrl = tailImageRef;
    }

    // 公司网关可灵 3.0 智能分镜：只接受精确模型名，且显式 false 必须关闭。
    // 网关协议里 multi_shot 是 JSON boolean（原生直连接口是字符串 "true"）。
    if (shouldInjectCompanyKlingMultiShot(request.model, request.multiShot)) {
      body.multi_shot = true;
      body.shot_type = 'intelligence';
    }

    // 公司网关要求 response_format=mp4，size 取文档白名单内的像素组合
    // （按首帧图比例吸附，档位偏好 1K）。首帧尺寸读不出来时省略 size。
    // 例外：可灵首尾帧模式（LastFrameUrl）下网关忽略 size、落回 16:9 默认值，
    // 比例必须改走 OutputConfig.AspectRatio（2026-08-17 实测合同）；
    // 网关透传的字段按腾讯原名 PascalCase，aspect_ratio 等 snake_case 变体
    // 会被 400 UnknownParameter 拒绝，禁止再猜字段。
    const companyCaps = companyVideoCapsForModel(request.model);
    if (companyCaps) {
      body.response_format = 'mp4';
      const sourceDims = await probeImageDimensions(request.sourceImagePath);
      if (tailProtocol === 'company-gateway-kling') {
        const aspectRatio = sourceDims
          ? snapCompanyVideoAspectRatio(sourceDims.width, sourceDims.height, companyCaps)
          : null;
        // Resolution 1080P 已经真实任务验证（2026-08-17）：不加时上游按默认档
        // 出 828x1108，加了出 1244x1660；末帧收束不受影响。
        // Duration 必须走 OutputConfig：网关 LastFrameUrl 分支不透传 seconds
        // （2026-08-18 实测落缺省 5s），而 OutputConfig 字段会原样透传给腾讯
        // （腾讯 Kling Duration 3-15，默认 5）；同日首尾帧真实任务验证
        // Duration=10 产出 10.042s 生效。
        const outputConfig: Record<string, unknown> = { Duration: request.durationSec };
        if (aspectRatio) {
          outputConfig.AspectRatio = aspectRatio;
          outputConfig.Resolution = '1080P';
        }
        body.OutputConfig = outputConfig;
      } else {
        const snappedSize = sourceDims
          ? snapCompanyVideoSize(sourceDims.width, sourceDims.height, companyCaps)
          : null;
        if (snappedSize) body.size = snappedSize;
      }
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
