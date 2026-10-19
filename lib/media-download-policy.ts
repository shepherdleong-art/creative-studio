import {
  downloadGatewayMedia,
  redactMediaUrlForLog,
  type GatewayMediaDownloadResult,
} from './gateway-media-url.ts';

export interface VideoMediaDownloadRequest {
  providerType: string;
  url: string;
  baseUrl: string;
  apiKey: string;
}

export interface GatewayDownloadFailureDescription {
  status: 'failed';
  providerStatus: 'download_failed';
  errorMessage: string;
  logUrl: string;
}

export function shouldPersistVideoResumeDownloadFailure(providerType: string): boolean {
  return providerType === 'openai-video';
}

/**
 * OpenAI-video gateways need redirect-aware per-hop authentication. Other
 * providers retain the previous direct unauthenticated media download path.
 */
export async function downloadVideoMediaForProvider(
  request: VideoMediaDownloadRequest,
): Promise<GatewayMediaDownloadResult> {
  if (request.providerType === 'openai-video') {
    return downloadGatewayMedia(request.url, request.baseUrl, request.apiKey);
  }

  try {
    const response = await fetch(request.url);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorMessage: `HTTP ${response.status}`,
      };
    }
    return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return { ok: false, errorMessage: 'Network error downloading remote video' };
  }
}

/** Map a remote-completed download failure to a terminal caller state. */
export function describeGatewayDownloadFailure(
  mediaLabel: 'image' | 'video',
  url: string,
  result: Extract<GatewayMediaDownloadResult, { ok: false }>,
  apiKey: string,
): GatewayDownloadFailureDescription {
  return {
    status: 'failed',
    providerStatus: 'download_failed',
    errorMessage: `Remote ${mediaLabel} ready but local download failed. ${result.errorMessage}`,
    logUrl: redactMediaUrlForLog(url, apiKey),
  };
}
