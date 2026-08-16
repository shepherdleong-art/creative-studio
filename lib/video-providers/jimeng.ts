import fs from 'fs';
import type {
  VideoProviderAdapter,
  SubmitVideoRequest,
  SubmitVideoResult,
  PollVideoResult,
  TailFrameCapability,
} from './types';

/**
 * Read a local image file and return as a Base64 data URL.
 */
function fileToBase64DataUrl(filePath: string, mimeType: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function normalizeJimengPrompt(prompt: string): string {
  return (prompt || 'gentle camera movement, stable product detail').trim();
}

function normalizeJimengDuration(durationSec: number, maxSec = 12): number {
  return Math.max(4, Math.min(maxSec, Number(durationSec) || 5));
}

function isSeedance2(model: string): boolean {
  return /seedance-2[-.]/.test(model);
}

const SEEDANCE_2_TAIL_FRAME_MODEL = 'doubao-seedance-2-0-260128';

function getTailFrameCapability(model: string): TailFrameCapability {
  if (model === SEEDANCE_2_TAIL_FRAME_MODEL) {
    return {
      supported: true,
      protocol: 'ark-content-roles',
    };
  }

  return {
    supported: false,
    reason: 'unsupported_model',
  };
}

type ArkTaskResponse = {
  id: string; // This IS the task_id
  model: string;
  status: string; // queued / running / succeeded / failed / expired / cancelled
  content?: {
    video_url?: string;
    last_frame_url?: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

function normalizeArkStatus(raw: string | undefined): PollVideoResult['status'] {
  if (!raw) return 'unknown';
  switch (raw.toLowerCase()) {
    case 'queued': return 'pending';
    case 'running': return 'processing';
    case 'succeeded': return 'succeeded';
    case 'failed':
    case 'expired':
    case 'cancelled': return 'failed';
    default: return 'unknown';
  }
}

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;
const JIMENG_2_LONG_VIDEO_MIN_POLLING_MS = 15 * 60_000;

export const jimengAdapter: VideoProviderAdapter = {
  tailFrameCapability(model) {
    return getTailFrameCapability(model);
  },

  minimumPollingTimeoutMs(request) {
    if (isSeedance2(request.model) && request.durationSec === 15) {
      return JIMENG_2_LONG_VIDEO_MIN_POLLING_MS;
    }
    return undefined;
  },

  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/contents/generations/tasks`;

    const hasTailImagePath = request.tailImagePath !== undefined;
    const hasTailMimeType = request.tailMimeType !== undefined;
    if (hasTailImagePath !== hasTailMimeType) {
      throw new Error('Jimeng tail frame requires tailImagePath and tailMimeType together');
    }
    if (hasTailImagePath && !getTailFrameCapability(request.model).supported) {
      throw new Error(`Jimeng tail frame unsupported for model ${request.model}`);
    }

    const imageDataUrl = fileToBase64DataUrl(request.sourceImagePath, request.sourceMimeType);

    // Seedance accepts public HTTPS/TOS/asset URLs. We use a data URL here because
    // the desktop app works with local files; if Ark rejects it, serve images publicly.
    console.warn('[Jimeng] Using Base64 data URL for source image. Seedance docs recommend public HTTPS URLs. If this fails, serve images publicly.');

    const seedance2 = isSeedance2(request.model);
    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: normalizeJimengPrompt(request.prompt),
      },
      {
        type: 'image_url',
        image_url: { url: imageDataUrl },
        ...(hasTailImagePath ? { role: 'first_frame' } : {}),
      },
    ];
    if (hasTailImagePath) {
      const tailImageDataUrl = fileToBase64DataUrl(request.tailImagePath!, request.tailMimeType!);
      content.push({
        type: 'image_url',
        image_url: { url: tailImageDataUrl },
        role: 'last_frame',
      });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      content,
      resolution: '1080p',
      ratio: 'adaptive',
      duration: normalizeJimengDuration(request.durationSec, seedance2 ? 15 : 12),
      watermark: false,
      generate_audio: true,
    };
    if (!seedance2) body.camera_fixed = false;

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
        const errorText = await res.text();
        throw new Error(`Jimeng submit error ${res.status}: ${errorText.slice(0, 500)}`);
      }

      const data = (await res.json()) as ArkTaskResponse;

      return {
        providerTaskId: data.id,
        rawResponse: data,
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
    const url = `${cleanBase}/contents/generations/tasks/${taskId}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          status: 'unknown',
          errorMessage: `Jimeng poll error ${res.status}: ${errorText.slice(0, 500)}`,
          rawResponse: null,
        };
      }

      const data = (await res.json()) as ArkTaskResponse;

      if (data.status === 'failed' || data.status === 'expired' || data.status === 'cancelled') {
        return {
          status: 'failed',
          errorMessage: data.error?.message || `Task ${data.status}`,
          rawResponse: data,
        };
      }

      const status = normalizeArkStatus(data.status);
      return {
        status,
        videoUrl: status === 'succeeded' ? data.content?.video_url : undefined,
        rawResponse: data,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
