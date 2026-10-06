import type { SeedanceOutputOptions } from './seedance-contract.ts';

export type TailFrameProtocol =
  | 'ark-content-roles'
  | 'company-gateway-kling'
  | 'company-gateway-qiniuyun-kling'
  | 'company-gateway-seedance';

export interface TailFrameCapability {
  supported: boolean;
  protocol?: TailFrameProtocol;
  reason?: 'unsupported_model' | 'contract_unverified';
}

export interface SubmitVideoRequest extends SeedanceOutputOptions {
  model: string;
  prompt: string;
  sourceImagePath: string;
  sourceMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  tailImagePath?: string;
  tailMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  durationSec: number;
  /** Company Tencent/Qiniu Kling 3.0 intelligent storyboard; omitted for other jobs. */
  multiShot?: boolean;
}

/**
 * 文生视频的显式合同：**没有首帧**，比例必须自己给（模型支持 adaptive 时可省略）。
 * 与旧的「首帧必填」合同并存，避免把 `sourceImagePath` 悄悄变成可选后到处容忍 undefined。
 */
export interface SubmitTextVideoRequest extends SeedanceOutputOptions {
  model: string;
  prompt: string;
  durationSec: number;
  /** 文本模式没有首帧可吸附，比例由调用方显式给出。 */
  aspectRatio?: string;
}

/**
 * 多模态参考的一份素材。方舟把它编成 content 数组里的 `image_url` / `video_url` / `audio_url` 项，
 * 角色分别是 `reference_image` / `reference_video` / `reference_audio`。
 *
 * 交付地址要求（方舟文档）：图片可以是公网 URL、Base64 data URL 或平台资产 ID；
 * **视频与音频只接受上游可访问的 URL**，因此这两类必须经 COS 中转，不能用本地路径。
 */
export interface ReferenceVideoInput {
  kind: 'image' | 'video' | 'audio';
  url: string;
  mimeType: string;
  durationSec?: number | null;
}

/**
 * 多模态参考的显式合同：**没有首帧**，参考素材按调用方顺序原样进入 content 数组。
 * 与首帧合同并存，避免把 `sourceImagePath` 变成可选后到处容忍 undefined。
 */
export interface SubmitReferenceVideoRequest extends SeedanceOutputOptions {
  model: string;
  prompt: string;
  references: ReadonlyArray<ReferenceVideoInput>;
  /** durationSec: -1 表示支持型号的自动时长；2.5 编辑固定为 -1。 */
  durationSec: number;
  /** 参考模式没有首帧可吸附，比例由调用方显式给出。 */
  aspectRatio?: string;
  /** 方舟 2.5 全模态参考子任务显式引导；仅 2.5 系列发送，缺省按 reference。 */
  omniReferenceTaskType?: 'reference' | 'edit' | 'extend';
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

export interface SubmitFinalVideoRequest {
  model: string;
  draftTaskId: string;
  outputFormat?: 'mp4' | 'mov';
  watermark?: boolean;
  returnLastFrame?: boolean;
}

export interface VideoProviderAdapter {
  submitFinal?(request: SubmitFinalVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  minimumPollingTimeoutMs?(request: Pick<SubmitVideoRequest, 'model' | 'durationSec'>): number | undefined;
  tailFrameCapability?(model: string): TailFrameCapability;
  submit(request: SubmitVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  /** 实现该方法才表示该供应商开放文生视频；未实现时画布不注册对应模式。 */
  submitText?(request: SubmitTextVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  /** 实现该方法才表示该供应商开放多模态参考；未实现时画布不注册视频生视频／参考生成模式。 */
  submitReference?(request: SubmitReferenceVideoRequest, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<SubmitVideoResult>;
  poll(taskId: string, apiKey: string, baseUrl: string, signal?: AbortSignal): Promise<PollVideoResult>;
}
