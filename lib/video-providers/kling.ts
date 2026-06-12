import fs from 'fs';
import crypto from 'crypto';
import type { VideoProviderAdapter, SubmitVideoRequest, SubmitVideoResult, PollVideoResult } from './types';

/**
 * Create a HS256 JWT for Kling API authentication.
 * Kling uses access_key (iss) and secret_key (HMAC SHA-256 signing).
 */
function createKlingJwt(accessKey: string, secretKey: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${b64Header}.${b64Payload}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Read a local image file and return raw Base64.
 */
function fileToBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64');
}

type KlingTaskResponse = {
  code: number;
  message: string;
  request_id?: string;
  data: {
    task_id: string;
    task_status: string;
    task_result?: {
      videos?: Array<{
        id: string;
        url: string;
        watermark_url?: string;
        duration: string;
      }>;
    };
  };
};

function normalizeKlingStatus(raw: string | undefined): PollVideoResult['status'] {
  if (!raw) return 'unknown';
  switch (raw.toLowerCase()) {
    case 'submitted': return 'pending';
    case 'processing': return 'processing';
    case 'succeed': return 'succeeded';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;

export const klingAdapter: VideoProviderAdapter = {
  async submit(
    request: SubmitVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const cleanBase = baseUrl.replace(/\/$/, '');
    const url = `${cleanBase}/v1/videos/image2video`;

    const imageBase64 = fileToBase64(request.sourceImagePath);

    const body = {
      model_name: request.model,
      image: imageBase64,
      prompt: request.prompt || 'gentle camera movement, stable product detail',
      duration: String(request.durationSec),
      mode: 'pro',
      sound: true,
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
        throw new Error(`Kling submit error ${res.status}: ${errorText.slice(0, 500)}`);
      }

      const data = (await res.json()) as KlingTaskResponse;

      if (data.code !== 0) {
        throw new Error(`Kling API error code=${data.code}: ${data.message}`);
      }

      return {
        providerTaskId: data.data.task_id,
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
    const url = `${cleanBase}/v1/videos/image2video/${taskId}`;

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
          errorMessage: `Kling poll error ${res.status}: ${errorText.slice(0, 500)}`,
          rawResponse: null,
        };
      }

      const data = (await res.json()) as KlingTaskResponse;

      if (data.code !== 0) {
        return {
          status: 'failed',
          errorMessage: `Kling API error code=${data.code}: ${data.message}`,
          rawResponse: data,
        };
      }

      const status = normalizeKlingStatus(data.data.task_status);
      const videoUrl = data.data.task_result?.videos?.[0]?.url;

      return {
        status,
        videoUrl: status === 'succeeded' ? videoUrl : undefined,
        rawResponse: data,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

/**
 * Generate a Kling JWT token from access key and secret key.
 * Export for use by the video queue (which may need to create fresh tokens).
 */
export function getKlingToken(accessKey: string, secretKey: string): string {
  return createKlingJwt(accessKey, secretKey);
}
