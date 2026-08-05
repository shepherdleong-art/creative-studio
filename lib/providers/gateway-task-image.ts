import fs from 'fs';
import { resolvePublicImageUrl } from '../local-image-url.ts';
import { isCosMediaConfigured, tryUploadToCosAndSign } from '../cos-media.ts';
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
 * 网关上游（腾讯等）只接受真实 URL 且限制 ~8KB 长度，data URL 会被 400 拒绝。
 * 优先上传腾讯云 COS 返回 24h 预签名 URL（配置 CREATIVE_STUDIO_COS_* 时）；
 * COS 失败或未配置时回退 CREATIVE_STUDIO_PUBLIC_BASE_URL 本机 HTTP URL，最后退 data URL。
 */
async function toGatewayImageRefAsync(filePath: string, mimeType: string): Promise<string> {
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

  // 与 geekai-json 一致的图片顺序约定：参考图在前，待编辑底图在最后。
  const imageUrls: string[] = [];
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    imageUrls.push(
      await toGatewayImageRefAsync(request.referenceImagePaths[i], request.referenceMimeTypes[i] || 'image/png')
    );
  }
  imageUrls.push(await toGatewayImageRefAsync(request.inputImagePath, request.inputMimeType));

  let prompt = request.prompt;
  const shouldUseSubjectGuidance =
    request.referenceGuidanceMode !== 'none' && request.referenceImagePaths.length > 0;
  if (shouldUseSubjectGuidance) {
    prompt = `图1-${request.referenceImagePaths.length}是风格/场景参考图，最后一张是需要编辑的原图。保持最后一张图的产品主体、比例、材质不变，参考前面图片调整场景、光线和布置。\n${request.prompt}`;
  }

  const body: Record<string, unknown> = {
    model: request.model,
    prompt,
    images: imageUrls,
  };
  // 公司网关（image2 / seedream 等）只接受文档白名单内的像素 size 且要求
  // response_format=jpeg；其余网关保持原样透传。
  const companyCaps = companyImageCapsForModel(request.model);
  if (companyCaps) {
    body.size = snapCompanyImageSize(request.size, companyCaps);
    body.response_format = 'jpeg';
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
