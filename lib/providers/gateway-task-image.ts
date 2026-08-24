import fs from 'fs';
import { resolvePublicImageUrl } from '../local-image-url.ts';
import { isCosMediaConfigured, tryUploadToCosAndSign, compressImageToBudget } from '../cos-media.ts';
import { companyImageCapsForModel, snapCompanyImageSize } from '../company-gateway-size.ts';
import {
  normalizeGatewayResultUrl,
  downloadGatewayMedia,
  sanitizeGatewayMediaDiagnostic,
  type GatewayMediaDownloadResult,
} from '../gateway-media-url.ts';

/**
 * 网关异步任务图片适配器（type = 'gateway-task-image'）。
 *
 * 适用于 New API 类统一中转网关把图片模型（如 image2-low/medium/high、
 * nano-banana 系列）挂在 OpenAI 风格任务协议下的情况：
 *   POST /v1/videos        提交任务（是的，图片也走这个端点），返回 { id, status }
 *   GET  /v1/videos/<id>   轮询，completed 后从 metadata.url 取结果图
 * 与 geekai-json 一样是「提交 → 轮询 → 下载」三段式异步流程。
 */

export interface GatewayTaskImageRequest {
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
  quality: string;
  referenceGuidanceMode?: 'preserve_subject' | 'none';
}

export interface GatewayTaskSubmitResult {
  taskId?: string;
  immediateImageUrl?: string;
  rawResponse: unknown;
}

export interface GatewayTaskPollResult {
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown';
  imageUrl?: string;
  errorMessage?: string;
  rawResponse: unknown;
}

type GatewayTaskResponse = {
  id?: string;
  status?: string; // queued / processing / completed / failed
  progress?: number;
  metadata?: { url?: string };
  output?: { url?: string };
  video?: { url?: string };
  result?: { video_url?: string; url?: string };
  video_url?: string;
  url?: string;
  error?: { code?: string; message?: string } | string;
};

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const MAX_POLL_TIME_MS = 900_000;

function normalizeGatewayStatus(raw: string | undefined): GatewayTaskPollResult['status'] {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase();
  if (['completed', 'succeed', 'success', 'succeeded', 'done'].includes(s)) return 'succeeded';
  if (['failed', 'fail', 'error', 'expired', 'cancelled'].includes(s)) return 'failed';
  if (['pending', 'queued'].includes(s)) return 'pending';
  if (['running', 'processing', 'in_progress'].includes(s)) return 'processing';
  return 'unknown';
}

// 产物 URL 的兼容结构（见《小林生影_AIGC模型调用文档》§4.2）：
// metadata.url / output.url / video.url / result.video_url / result.url / video_url / url
function extractImageUrl(data: GatewayTaskResponse): string | undefined {
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

function extractErrorMessage(data: GatewayTaskResponse): string | undefined {
  if (!data.error) return undefined;
  if (typeof data.error === 'string') return data.error;
  return data.error.message || data.error.code;
}

export function summarizeGatewayTaskResponse(obj: unknown, apiKey = ''): string {
  const d = obj as GatewayTaskResponse | undefined;
  if (!d) return 'null';
  const parts: string[] = [];
  if (d.status) parts.push(`status=${d.status}`);
  if (d.progress !== undefined) parts.push(`progress=${d.progress}`);
  parts.push(`hasUrl=${!!extractImageUrl(d)}`);
  const err = extractErrorMessage(d);
  if (err) parts.push(`error=${sanitizeGatewayMediaDiagnostic(err, apiKey).slice(0, 100)}`);
  return parts.join(' ') || 'empty';
}

function fileToDataUrl(filePath: string, mimeType: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * 公司网关七牛云下游（qiniuyun/*）的免 COS 通道：实测该链路接受 data URL
 * 参考图（2026-08-21 经公司网关全链路验证 15KB~28MB body 成功）。瓶颈是网关
 * nginx 请求体上限（28.3MB 通过、40.8MB 被 413），因此 ≤20MB 的原图不压缩
 * 直接内联（保画面细节），>20MB 才压到 ≤6MB/4096px/q92 再内联；压缩失败
 * （如 gif 超限）返回 null，由调用方回退既有 COS/本机 URL 通道。
 * 阈值可用 CREATIVE_STUDIO_INLINE_RAW_MAX_BYTES / INLINE_TARGET_BYTES /
 * INLINE_TARGET_DIM / INLINE_TARGET_QUALITY 覆盖。
 */
const INLINE_DATAURL_MODEL = /^qiniuyun\//i;

/** 实测接受 response_format=png 并返回无损 PNG 的公司下游（2026-08-21 真实任务验证） */
const PNG_RESPONSE_FORMAT_MODEL = /^qiniuyun\//i;

function inlineIntEnv(name: string, fallback: number): number {
  const v = Number.parseInt((process.env[name] || '').trim(), 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

async function toInlineDataUrl(filePath: string, mimeType: string): Promise<string | null> {
  const raw = (await fs.promises.readFile(filePath)) as Buffer<ArrayBuffer>;
  const rawMaxBytes = inlineIntEnv('CREATIVE_STUDIO_INLINE_RAW_MAX_BYTES', 20 * 1024 * 1024);
  if (raw.byteLength <= rawMaxBytes) {
    return `data:${mimeType};base64,${raw.toString('base64')}`;
  }
  const compressed = await compressImageToBudget(raw, mimeType, {
    maxBytes: inlineIntEnv('CREATIVE_STUDIO_INLINE_TARGET_BYTES', 6 * 1024 * 1024),
    maxDim: inlineIntEnv('CREATIVE_STUDIO_INLINE_TARGET_DIM', 4096),
    quality: inlineIntEnv('CREATIVE_STUDIO_INLINE_TARGET_QUALITY', 92),
  });
  if (!compressed) return null;
  return `data:${compressed.mime};base64,${compressed.buffer.toString('base64')}`;
}

/**
 * 网关上游（腾讯等）只接受真实 URL 且限制 ~8KB 长度，data URL 会被 400 拒绝。
 * 优先上传腾讯云 COS 返回 24h 预签名 URL（配置 CREATIVE_STUDIO_COS_* 时）；
 * COS 失败或未配置时回退 CREATIVE_STUDIO_PUBLIC_BASE_URL 本机 HTTP URL，最后退 data URL。
 * qiniuyun/* 模型例外：见 toInlineDataUrl 的免 COS 内联通道。
 */
async function toGatewayImageRefAsync(filePath: string, mimeType: string, model: string): Promise<string> {
  if (INLINE_DATAURL_MODEL.test(model)) {
    try {
      const inline = await toInlineDataUrl(filePath, mimeType);
      if (inline) return inline;
    } catch (error) {
      console.warn('[gateway-task-image] 参考图内联失败，回退 URL 通道：', error instanceof Error ? error.message : error);
    }
  }
  if (isCosMediaConfigured()) {
    try {
      const cosUrl = await tryUploadToCosAndSign(filePath, mimeType);
      if (cosUrl) return cosUrl;
    } catch (error) {
      console.warn('[cos-media] 参考图上传 COS 失败，回退本机 URL：', error instanceof Error ? error.message : error);
    }
  }
  return resolvePublicImageUrl(filePath) ?? fileToDataUrl(filePath, mimeType);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeoutSignal(
  parent: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms);

  const onAbort = () => controller.abort();
  parent?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export async function submitGatewayTaskImage(
  request: GatewayTaskImageRequest,
  apiKey: string,
  baseUrl: string
): Promise<GatewayTaskSubmitResult> {
  const cleanBase = baseUrl.replace(/\/$/, '');

  // 与 packy-images / openai-compatible 一致的图片顺序约定：待编辑底图在前（图1），参考图在后（图2-N）。
  // 项目默认提示词与存量项目提示词均按「图1=底图、图2=参考图」书写。
  const imageUrls: string[] = [
    await toGatewayImageRefAsync(request.inputImagePath, request.inputMimeType, request.model),
  ];
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    imageUrls.push(
      await toGatewayImageRefAsync(request.referenceImagePaths[i], request.referenceMimeTypes[i] || 'image/png', request.model)
    );
  }

  let prompt = request.prompt;
  const shouldUseSubjectGuidance =
    request.referenceGuidanceMode !== 'none' && request.referenceImagePaths.length > 0;
  if (shouldUseSubjectGuidance) {
    const refRange = request.referenceImagePaths.length === 1 ? '图2' : `图2-${request.referenceImagePaths.length + 1}`;
    prompt = `图1是需要编辑的原图，${refRange}是风格/场景参考图。保持图1的产品主体、比例、材质不变，参考后面的图片调整场景、光线和布置。\n${request.prompt}`;
  }

  const body: Record<string, unknown> = {
    model: request.model,
    prompt,
    images: imageUrls,
  };
  // 公司网关（image2 / seedream 等）只接受文档白名单内的像素 size。产物格式按
  // 下游分派：qiniuyun/* 实测（2026-08-21 真实任务）接受 response_format=png 并
  // 返回无损 PNG（2K 3:4 约 2.8MB；jpeg 仅 ~300KB，压缩痕迹明显、产品图发糊），
  // image2/seedream 维持历史验证过的 jpeg；其余网关保持原样透传。
  const companyCaps = companyImageCapsForModel(request.model);
  if (companyCaps) {
    body.size = snapCompanyImageSize(request.size, companyCaps);
    body.response_format = PNG_RESPONSE_FORMAT_MODEL.test(request.model) ? 'png' : 'jpeg';
  } else if (request.size) {
    body.size = request.size;
  }

  const url = `${cleanBase}/v1/videos`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

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
      throw new Error(`Gateway task submit error ${res.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await res.json()) as GatewayTaskResponse;
    const taskId = data.id;
    const imageUrl = normalizeGatewayResultUrl(extractImageUrl(data), cleanBase);
    const status = normalizeGatewayStatus(data.status);

    // 同步直接出图（少见，但网关允许 completed 立即返回）
    if (imageUrl && status === 'succeeded') {
      return { taskId, immediateImageUrl: imageUrl, rawResponse: data };
    }

    if (taskId) {
      return { taskId, rawResponse: data };
    }

    throw new Error(`Gateway task 未返回任务 id：${sanitizeGatewayMediaDiagnostic(safeJson(data), apiKey)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function pollGatewayTaskImage(
  taskId: string,
  apiKey: string,
  baseUrl: string,
  startedAt: number,
  signal?: AbortSignal
): Promise<GatewayTaskPollResult> {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const pollUrl = `${cleanBase}/v1/videos/${taskId}`;

  const elapsedMs = Date.now() - startedAt;
  const pollIntervalMs = elapsedMs < 120_000 ? 5000 : 10000;

  if (elapsedMs >= MAX_POLL_TIME_MS) {
    return {
      status: 'unknown',
      errorMessage: `Polling timeout after ${MAX_POLL_TIME_MS / 1000}s`,
      rawResponse: null,
    };
  }

  await sleep(Math.min(pollIntervalMs, MAX_POLL_TIME_MS - elapsedMs));

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const timeout = withTimeoutSignal(signal, POLL_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeout.signal,
    });

    if (!res.ok) {
      const errorText = sanitizeGatewayMediaDiagnostic(await res.text(), apiKey);
      return {
        status: 'unknown',
        errorMessage: `Poll error ${res.status}: ${errorText.slice(0, 500)}`,
        rawResponse: null,
      };
    }

    const data = (await res.json()) as GatewayTaskResponse;
    const status = normalizeGatewayStatus(data.status);
    const imageUrl = normalizeGatewayResultUrl(extractImageUrl(data), cleanBase);

    if (status === 'succeeded') {
      // 公司网关完成态常常不带产物 URL（文档 §4.3）：回退到 /content 端点下载。
      // 必须用提交时返回的原始任务 id 拼地址——轮询响应里的 id 可能丢失
      // model_id，LiteLLM 代理凭它会路由到错误的默认上游。
      return {
        status: 'succeeded',
        imageUrl: imageUrl ?? `${cleanBase}/v1/videos/${taskId}/content`,
        rawResponse: data,
      };
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        errorMessage: sanitizeGatewayMediaDiagnostic(extractErrorMessage(data) || 'unknown gateway task error', apiKey),
        rawResponse: data,
      };
    }

    return { status, rawResponse: data };
  } finally {
    timeout.cleanup();
  }
}

export async function downloadGatewayTaskImage(
  url: string,
  baseUrl: string,
  apiKey: string
): Promise<GatewayMediaDownloadResult> {
  // 结果指向网关自身的 /content 端点时需要 Bearer 鉴权；指向 CDN 时不带任何头
  return downloadGatewayMedia(url, baseUrl, apiKey);
}

function safeJson(obj: unknown, maxLen = 2000): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}
