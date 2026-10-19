import fs from 'fs';
import { resolvePublicImageUrl } from '../local-image-url.ts';
import { isCosMediaConfigured, tryUploadToCosAndSign, compressImageToBudget } from '../cos-media.ts';
import { companyImageCapsForModel, snapCompanyImageSize, companyImageOutputConfig } from '../company-gateway-size.ts';
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
  /** 每张入图实际使用的传输通道（与 images 顺序一致），供队列层记日志 */
  imageTransports?: ImageTransport[];
  rawResponse: unknown;
}

/** 入图传输通道：内联 base64 / COS 预签名 URL / 本机 HTTP URL / 裸 data URL 兜底 */
export type ImageTransport = 'inline-data-url' | 'cos-url' | 'local-url' | 'data-url';

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
 * INLINE_TARGET_DIM / INLINE_TARGET_QUALITY 覆盖；CREATIVE_STUDIO_QINIUYUN_INLINE=0
 * 可整体关停内联（强制走 COS/URL），用于排查上游安全拦截与传输方式的关系。
 */
const INLINE_DATAURL_MODEL = /^qiniuyun\//i;

/**
 * qiniuyun/* 内联通道的运行时开关：CREATIVE_STUDIO_QINIUYUN_INLINE=0 时跳过
 * 内联，强制走 COS/本机 URL（用于排查上游安全系统拦截是否与传输方式相关）。
 * 默认开启，保持 2026-08-21 实测验证过的现状。
 */
function isInlineDataUrlEnabled(model: string): boolean {
  if (!INLINE_DATAURL_MODEL.test(model)) return false;
  return (process.env.CREATIVE_STUDIO_QINIUYUN_INLINE || '1').trim() !== '0';
}

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
async function toGatewayImageRefAsync(
  filePath: string,
  mimeType: string,
  model: string
): Promise<{ url: string; transport: ImageTransport }> {
  if (isInlineDataUrlEnabled(model)) {
    try {
      const inline = await toInlineDataUrl(filePath, mimeType);
      if (inline) return { url: inline, transport: 'inline-data-url' };
    } catch (error) {
      console.warn('[gateway-task-image] 参考图内联失败，回退 URL 通道：', error instanceof Error ? error.message : error);
    }
  }
  if (isCosMediaConfigured()) {
    try {
      const cosUrl = await tryUploadToCosAndSign(filePath, mimeType);
      if (cosUrl) return { url: cosUrl, transport: 'cos-url' };
    } catch (error) {
      console.warn('[cos-media] 参考图上传 COS 失败，回退本机 URL：', error instanceof Error ? error.message : error);
    }
  }
  const localUrl = resolvePublicImageUrl(filePath);
  if (localUrl) return { url: localUrl, transport: 'local-url' };
  return { url: fileToDataUrl(filePath, mimeType), transport: 'data-url' };
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
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });

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
  baseUrl: string,
  options: { onProgress?: (message: string) => void; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GatewayTaskSubmitResult> {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const isSeedreamPro = request.model === 'doubao-seedream-5-0-pro-image';
  const isNanoBanana = request.model === 'nano-banana-3.0' || request.model === 'nano-banana-3.1';
  if ((isSeedreamPro || isNanoBanana) && request.referenceImagePaths.length + 1 > 14) {
    throw new Error('该模型最多支持 14 张输入图片（含待编辑底图），请减少参考图');
  }
  if (isNanoBanana && !isCosMediaConfigured()) {
    throw new Error('公司 Nano Banana 参考图需要配置 CREATIVE_STUDIO_COS_* 公网中转');
  }

  // 与 packy-images / openai-compatible 一致的图片顺序约定：待编辑底图在前（图1），参考图在后（图2-N）。
  // 项目默认提示词与存量项目提示词均按「图1=底图、图2=参考图」书写。
  const imageUrls: string[] = [];
  const imageTransports: ImageTransport[] = [];
  const pushRef = (r: { url: string; transport: ImageTransport }) => {
    imageUrls.push(r.url);
    imageTransports.push(r.transport);
  };
  pushRef(await toGatewayImageRefAsync(request.inputImagePath, request.inputMimeType, request.model));
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    pushRef(
      await toGatewayImageRefAsync(request.referenceImagePaths[i], request.referenceMimeTypes[i] || 'image/png', request.model)
    );
  }
  if (isNanoBanana && imageTransports.some(t => t !== 'cos-url')) {
    throw new Error('公司 Nano Banana 参考图上传 COS 失败，任务未提交');
  }

  let prompt = request.prompt;
  const shouldUseSubjectGuidance =
    request.referenceGuidanceMode !== 'none' && request.referenceImagePaths.length > 0;
  if (shouldUseSubjectGuidance) {
    const refRange = request.referenceImagePaths.length === 1 ? '图2' : `图2-${request.referenceImagePaths.length + 1}`;
    prompt = `图1是需要编辑的原图，${refRange}是风格/场景参考图。保持图1的产品主体、比例、材质不变，参考后面的图片调整场景、光线和布置。\n${request.prompt}`;
  }

  // 公司 Seedream 5.0 Pro 下游为方舟同步 JSON 图片接口：image（单数）接收
  // 按顺序排列的底图和参考图。沿用 immediateImageUrl 合同，不改队列或轮询逻辑。
  if (isSeedreamPro) {
    const caps = companyImageCapsForModel(request.model)!;
    const output = companyImageOutputConfig(request.size, caps);
    // 同步生图等待完整生成结果，应沿用项目超时；未提供时默认 10 分钟。
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
      ? options.timeoutMs! : 600_000;
    const requestTimeout = withTimeoutSignal(options.signal, timeoutMs);
    const startedAt = Date.now();
    const elapsedSeconds = () => Math.round((Date.now() - startedAt) / 1000);
    const reportWaiting = () => options.onProgress?.(`Seedream 5.0 Pro 等待生成响应（已等待 ${elapsedSeconds()} 秒，超时上限 ${Math.round(timeoutMs / 1000)} 秒）`);
    reportWaiting();
    // 同步接口没有远端任务 ID；这里只记录本地等待时间，不额外提交或伪造轮询。
    const progressTimer = options.onProgress ? setInterval(reportWaiting, 5000) : undefined;
    try {
      // 方舟推荐档位 + 提示词宽高比。公司链路传具体像素会回落到默认 2K，
      // 2026-09-29 实测 size=1K 才能正确得到 1K 产物。
      const response = await fetch(`${cleanBase}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: request.model,
          prompt: `${prompt}\n输出画幅为${output.AspectRatio}，清晰度为${output.Resolution}。`, image: imageUrls,
          size: output.Resolution, n: 1, response_format: 'url' }),
        signal: requestTimeout.signal,
      });
      if (!response.ok) {
        throw new Error(`Seedream 图片生成失败 ${response.status}: ${sanitizeGatewayMediaDiagnostic(await response.text(), apiKey).slice(0, 500)}`);
      }
      const data = await response.json() as { data?: Array<{ url?: string; error?: { message?: string } }>; error?: { message?: string }; usage?: unknown };
      const immediateImageUrl = normalizeGatewayResultUrl(data.data?.[0]?.url, cleanBase);
      if (!immediateImageUrl) {
        throw new Error(`Seedream 未返回图片 URL: ${sanitizeGatewayMediaDiagnostic(data.error?.message || data.data?.[0]?.error?.message || '响应缺少 data[0].url', apiKey)}`);
      }
      options.onProgress?.(`Seedream 5.0 Pro 生成响应已返回（耗时 ${elapsedSeconds()} 秒），开始下载图片`);
      return { immediateImageUrl, imageTransports, rawResponse: { status: 'completed', usage: data.usage } };
    } catch (error) {
      options.onProgress?.(`Seedream 5.0 Pro 请求异常结束（已等待 ${elapsedSeconds()} 秒）`);
      throw error;
    } finally {
      clearInterval(progressTimer);
      requestTimeout.cleanup();
    }
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
    if (isNanoBanana) body.OutputConfig = companyImageOutputConfig(request.size, companyCaps);
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
      return { taskId, immediateImageUrl: imageUrl, imageTransports, rawResponse: data };
    }

    if (taskId) {
      return { taskId, imageTransports, rawResponse: data };
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
