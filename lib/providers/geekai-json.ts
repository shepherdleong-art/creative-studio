import fs from 'fs';

export interface EditImageRequest {
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
  quality: string;
}

export interface GeekAISubmitResult {
  taskId?: string;
  immediateImageUrl?: string;
  immediateImageBase64?: string;
  rawResponse: unknown;
}

export interface GeekAIPollResult {
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown';
  imageUrl?: string;
  imageBase64?: string;
  errorMessage?: string;
  rawResponse: unknown;
}

// ── GeekAI real response shape ──
// Docs: https://docs.geekai.co/cn/api/image/result
// {
//   "task_id": "...",
//   "task_status": "succeed",   // pending / running / succeed / failed
//   "data": [{ "url": "...", "b64_json": "..." }],
//   "error": { "message": "..." }
// }
type GeekAIResponse = {
  created?: number;
  task_id?: string;
  id?: string;
  task_status?: string;
  status?: string;
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  output?: { url?: string; b64_json?: string };
  error?: { message?: string; code?: string } | string;
};

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const MAX_POLL_TIME_MS = 900_000;

// ── Helpers ──

/** Normalize GeekAI's various status strings into a standard enum. */
function normalizeGeekAIStatus(raw: string | undefined): GeekAIPollResult['status'] {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase();
  if (['succeed', 'success', 'succeeded', 'completed', 'done'].includes(s)) return 'succeeded';
  if (['failed', 'fail', 'error'].includes(s)) return 'failed';
  if (['pending', 'queued'].includes(s)) return 'pending';
  if (['running', 'processing', 'in_progress'].includes(s)) return 'processing';
  return 'unknown';
}

function extractGeekAIImageUrl(data: GeekAIResponse): string | undefined {
  return data.data?.[0]?.url || data.output?.url || undefined;
}

function extractGeekAIImageBase64(data: GeekAIResponse): string | undefined {
  return data.data?.[0]?.b64_json || data.output?.b64_json || undefined;
}

function extractErrorMessage(data: GeekAIResponse): string | undefined {
  if (!data.error) return undefined;
  if (typeof data.error === 'string') return data.error;
  return data.error.message || data.error.code;
}

function safeJson(obj: unknown, maxLen = 2000): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Summarize GeekAI response for logging.
 * Includes: task_status, data.length, hasUrl, error
 */
export function summarizeGeekAIResponse(obj: unknown): string {
  const d = obj as GeekAIResponse | undefined;
  if (!d) return 'null';
  const parts: string[] = [];
  const rawStatus = d.task_status || d.status;
  if (rawStatus) parts.push(`task_status=${rawStatus}`);
  if (d.data) parts.push(`data.length=${d.data.length}`);
  const url = extractGeekAIImageUrl(d);
  parts.push(`hasUrl=${!!url}`);
  const err = extractErrorMessage(d);
  if (err) parts.push(`error=${err.slice(0, 100)}`);
  return parts.join(' ') || 'empty';
}

// ── AbortSignal helper ──

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

// ── Public API ──

export async function submitGeekAITask(
  request: EditImageRequest,
  apiKey: string,
  baseUrl: string
): Promise<GeekAISubmitResult> {
  const cleanBase = baseUrl.replace(/\/$/, '');

  const imageUrls: string[] = [];
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    imageUrls.push(
      fileToDataUrl(request.referenceImagePaths[i], request.referenceMimeTypes[i] || 'image/png')
    );
  }
  imageUrls.push(fileToDataUrl(request.inputImagePath, request.inputMimeType));

  let prompt = request.prompt;
  if (imageUrls.length > 1) {
    prompt = `图1-${request.referenceImagePaths.length}是风格/场景参考图，最后一张是需要编辑的原图。保持最后一张图的产品主体、比例、材质不变，参考前面图片调整场景、光线和布置。\n${request.prompt}`;
  }

  const body = {
    model: request.model,
    prompt,
    images: imageUrls,
    size: request.size,
    quality: request.quality,
    background: 'auto',
    output_format: 'png',
    response_format: 'url',
    async: true,
  };

  const url = `${cleanBase}/v1/images/edits`;

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
      const errorText = await res.text();
      throw new Error(`GeekAI submit error ${res.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await res.json()) as GeekAIResponse;
    const taskId = data.task_id || data.id;
    const imageUrl = extractGeekAIImageUrl(data);
    const imageBase64 = extractGeekAIImageBase64(data);
    const rawStatus = data.task_status || data.status;

    // If we got a task_id and no image yet (normal async case)
    if (taskId && !imageUrl && !imageBase64) {
      return { taskId, rawResponse: data };
    }

    // Sync/immediate result
    return {
      taskId,
      immediateImageUrl: imageUrl,
      immediateImageBase64: imageBase64,
      rawResponse: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function pollGeekAITask(
  taskId: string,
  apiKey: string,
  baseUrl: string,
  startedAt: number,
  signal?: AbortSignal
): Promise<GeekAIPollResult> {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const pollUrl = `${cleanBase}/v1/images/${taskId}`;

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

  // Combine user cancel signal with per-request timeout
  const timeout = withTimeoutSignal(signal, POLL_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeout.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        status: 'unknown',
        errorMessage: `Poll error ${res.status}: ${errorText.slice(0, 500)}`,
        rawResponse: null,
      };
    }

    const data = (await res.json()) as GeekAIResponse;

    // Use real field names: task_status (not status), data[0].url (not output.url)
    const rawStatus = data.task_status || data.status;
    const status = normalizeGeekAIStatus(rawStatus);
    const imageUrl = extractGeekAIImageUrl(data);
    const imageBase64 = extractGeekAIImageBase64(data);

    if (status === 'succeeded') {
      if (imageUrl || imageBase64) {
        return { status: 'succeeded', imageUrl, imageBase64, rawResponse: data };
      }
      // Succeeded but no image — don't keep polling
      return {
        status: 'failed',
        errorMessage: `GeekAI returned succeed but no image. Raw: ${safeJson(data)}`,
        rawResponse: data,
      };
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        errorMessage: extractErrorMessage(data) || 'unknown GeekAI error',
        rawResponse: data,
      };
    }

    return { status, rawResponse: data };
  } finally {
    timeout.cleanup();
  }
}

export async function downloadGeekAIImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch {
    return null;
  }
}

function fileToDataUrl(filePath: string, mimeType: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
