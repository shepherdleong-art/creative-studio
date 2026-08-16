export type TailFrameProtocol =
  | 'ark-content-roles'
  | 'company-gateway-kling'
  | 'company-gateway-seedance';

export interface TailFrameCapability {
  supported: boolean;
  protocol?: TailFrameProtocol;
  reason?: 'unsupported_model' | 'contract_unverified';
}

export interface SubmitVideoRequest {
  model: string;
  prompt: string;
  sourceImagePath: string;
  sourceMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  tailImagePath?: string;
  tailMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
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
  minimumPollingTimeoutMs?(request: Pick<SubmitVideoRequest, 'model' | 'durationSec'>): number | undefined;
  tailFrameCapability?(model: string): TailFrameCapability;
  submit(request: SubmitVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  poll(taskId: string, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<PollVideoResult>;
}
