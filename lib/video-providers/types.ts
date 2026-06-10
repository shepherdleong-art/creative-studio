export interface SubmitVideoRequest {
  model: string;
  prompt: string;
  sourceImagePath: string;
  sourceMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  durationSec: number;
}

export interface SubmitVideoResult {
  providerTaskId?: string;
  immediateVideoUrl?: string;
  rawResponse: unknown;
}

export interface PollVideoResult {
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown';
  videoUrl?: string;
  errorMessage?: string;
  rawResponse: unknown;
}

export interface VideoProviderAdapter {
  submit(request: SubmitVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  poll(taskId: string, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<PollVideoResult>;
}
