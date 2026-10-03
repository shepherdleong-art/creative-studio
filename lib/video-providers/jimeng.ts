import { assertArkRequestSize, seedanceFinalBody, seedanceContract, seedanceOutputFields } from './seedance-contract.ts';
import fs from 'fs';
import type {
  ReferenceVideoInput,
  VideoProviderAdapter,
  SubmitVideoRequest,
  SubmitTextVideoRequest,
  SubmitReferenceVideoRequest,
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
  if (durationSec === -1 && maxSec >= 15) return -1;
  return Math.max(4, Math.min(maxSec, Number(durationSec) || 5));
}

function isSeedance2(model: string): boolean {
  return /seedance-2[-.]/.test(model);
}

/** 2.5 系列（doubao-seedance-2-5-*）：单段最长 30 秒，全模态参考需显式引导子任务类型。 */
function isSeedance25(model: string): boolean {
  return /seedance-2-5[-.]/.test(model);
}

/** 各代模型的单段时长上限：2.5 → 30s，其余 2.x → 15s，更早的即梦 → 12s。 */
function maxJimengDurationSec(model: string): number {
  if (isSeedance25(model)) return 30;
  if (isSeedance2(model)) return 15;
  return 12;
}

/**
 * 尾帧按精确模型 allowlist 声明（红线：不许放宽成前缀匹配）。
 * 2.5 官方教程：首尾帧生视频严格通过 content.role = first_frame/last_frame 控制，
 * ratio 必须为 adaptive——本适配器图生视频路径本就固定 adaptive，合同一致。
 */
const SEEDANCE_2_TAIL_FRAME_MODELS: ReadonlyArray<string> = [
  'doubao-seedance-2-0-260128',
  'doubao-seedance-2-5-260628',
];

function getTailFrameCapability(model: string): TailFrameCapability {
  if (SEEDANCE_2_TAIL_FRAME_MODELS.includes(model)) {
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

/**
 * 方舟多模态参考的一项：图片／视频／音频各自一种 content 项类型，角色标明用途。
 * 来源：方舟创建视频生成任务文档（角色名见 docs/2026-09-08-无限画布-公司模型接口核对.md §二）。
 */
function referenceContentItem(reference: ReferenceVideoInput): Record<string, unknown> {
  switch (reference.kind) {
    case 'image':
      return { type: 'image_url', image_url: { url: reference.url }, role: 'reference_image' };
    case 'video':
      return { type: 'video_url', video_url: { url: reference.url }, role: 'reference_video' };
    case 'audio':
      return { type: 'audio_url', audio_url: { url: reference.url }, role: 'reference_audio' };
  }
}

/** 三个提交入口共用的单次 POST：超时与外部中止信号都转成 AbortController。 */
async function postGenerationTask(params: {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  errorLabel: string;
}): Promise<SubmitVideoResult> {
  const cleanBase = params.baseUrl.replace(/\/$/, '');
  const url = `${cleanBase}/contents/generations/tasks`;

  const serialized = assertArkRequestSize(params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (params.signal?.aborted) controller.abort();
  else params.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: serialized,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`${params.errorLabel} submit error ${res.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await res.json()) as ArkTaskResponse;
    return { providerTaskId: data.id, rawResponse: data };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}

export const jimengAdapter: VideoProviderAdapter = {
  async submitFinal(request, apiKey, baseUrl, signal) {
    return postGenerationTask({ apiKey, baseUrl, signal, body: seedanceFinalBody(request), errorLabel: 'Jimeng final-from-draft' });
  },
  tailFrameCapability(model) {
    return getTailFrameCapability(model);
  },

  minimumPollingTimeoutMs(request) {
    if (isSeedance2(request.model) && request.durationSec >= 15) {
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
        ...(hasTailImagePath || seedanceContract(request.model) ? { role: 'first_frame' } : {}),
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
      ...seedanceOutputFields(request.model, request),
      ratio: 'adaptive',
      duration: normalizeJimengDuration(request.durationSec, maxJimengDurationSec(request.model)),
    };
    if (!seedance2) body.camera_fixed = false;

    return postGenerationTask({
      apiKey,
      baseUrl,
      body,
      ...(signal ? { signal } : {}),
      errorLabel: 'Jimeng',
    });
  },

  /**
   * 文生视频：方舟原生 content 只放文本项，**不塞占位首帧**；文本模式没有图可吸附，
   * 比例取调用方显式值（默认 16:9），其余参数与图生视频保持一致。
   */
  async submitText(
    request: SubmitTextVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const seedance2 = isSeedance2(request.model);
    const body: Record<string, unknown> = {
      model: request.model,
      content: [{ type: 'text', text: normalizeJimengPrompt(request.prompt) }],
      ...seedanceOutputFields(request.model, request),
      ratio: request.aspectRatio ?? '16:9',
      duration: normalizeJimengDuration(request.durationSec, maxJimengDurationSec(request.model)),
    };
    if (!seedance2) body.camera_fixed = false;

    return postGenerationTask({
      apiKey,
      baseUrl,
      body,
      ...(signal ? { signal } : {}),
      errorLabel: 'Jimeng text-to-video',
    });
  },

  /**
   * 多模态参考：图片／视频／音频按调用方顺序进 content 数组，角色分别是
   * `reference_image` / `reference_video` / `reference_audio`。
   *
   * 数量与组合约束（2.0 系列：0–9 图 + 0–3 视频 + 0–3 音频，音频必须搭配图片或视频）在画布能力表与
   * external 适配器的 prepare 阶段校验；这里只负责把已经过校验的素材编成请求，避免两处规则漂移。
   * 素材地址由 prepare 交付：图片可以是 data URL，视频／音频必须是公网 URL（COS 中转）。
   */
  async submitReference(
    request: SubmitReferenceVideoRequest,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<SubmitVideoResult> {
    const seedance2 = isSeedance2(request.model);
    const seedance25 = isSeedance25(request.model);
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: normalizeJimengPrompt(request.prompt) },
      ...request.references.map(referenceContentItem),
    ];
    const body: Record<string, unknown> = {
      model: request.model,
      content,
      ...seedanceOutputFields(request.model, request),
      ratio: request.aspectRatio ?? '16:9',
      // 自动时长支持两代，旧非 Seedance 调用保持原归一行为
      duration: seedance25 && request.durationSec === -1
        ? -1
        : normalizeJimengDuration(request.durationSec, maxJimengDurationSec(request.model)),
    };
    if (!seedance2) body.camera_fixed = false;
    if (seedance25) {
      // 2.5 全模态参考按提示词意图判定子任务（参考／编辑／延长），编辑与延长会锁定 ratio／duration；
      // 画布按节点模式显式引导子任务类型，把参数冲突前置为同步报错（方舟官方教程推荐做法）。
      body.omni_reference_task_type = request.omniReferenceTaskType ?? 'reference';
    }

    return postGenerationTask({
      apiKey,
      baseUrl,
      body,
      ...(signal ? { signal } : {}),
      errorLabel: 'Jimeng reference-to-video',
    });
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
