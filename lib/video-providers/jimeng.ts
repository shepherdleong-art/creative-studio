import fs from 'fs';
import type { VideoProviderAdapter, SubmitVideoRequest, SubmitVideoResult, PollVideoResult } from './types';

/**
 * Read a local image file and return as a Base64 data URL.
 */
function fileToBase64DataUrl(filePath: string, mimeType: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
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

export const jimengAdapter: VideoProviderAdapter = {
  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/contents/generations/tasks`;

    const imageDataUrl = fileToBase64DataUrl(request.sourceImagePath, request.sourceMimeType);

    // NOTE: Seedance 2.0 official docs specify public HTTPS URLs, TOS URLs, or asset:// URLs
    // for reference media. Base64 data URLs may or may not be accepted depending on deployment.
    // If Seedance returns 4xx on image_url, serve images via a public URL instead.
    console.warn('[Jimeng] Using Base64 data URL for source image. Seedance docs recommend public HTTPS URLs. If this fails, serve images publicly.');

    const body = {
      model: request.model,
      content: [
        {
          type: 'text',
          text: request.prompt || 'gentle camera movement, stable product detail',
        },
        {
          type: 'image_url',
          image_url: { url: imageDataUrl },
          role: 'first_frame',
        },
      ],
      duration: request.durationSec,
      resolution: '720p',
      ratio: 'adaptive',
      watermark: false,
      generate_audio: false,
    };

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
        headers: { Authorization: `Bearer ${apiKey}` },
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
