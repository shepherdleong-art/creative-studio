import { companyNativeVideoModel } from './company-gateway-video-models.ts';
import { videoDurationError } from './video-duration.ts';
import {
  SEEDANCE_20,
  SEEDANCE_25,
  SEEDANCE_FAST,
  SEEDANCE_REFERENCE_ASPECT_RATIOS,
  seedanceContract,
  seedanceOutputFields,
} from './video-providers/seedance-contract.ts';

export type VideoReferenceKind = 'image' | 'video' | 'audio';

export interface VideoReferenceKindCapability {
  maxCount: number;
  mimeTypes: readonly string[];
  maxBytes: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  maxTotalDurationSec?: number;
}

export interface SupportedVideoReferenceCapability {
  supported: true;
  image: VideoReferenceKindCapability;
  video: VideoReferenceKindCapability;
  audio: VideoReferenceKindCapability;
  allowsAudioOnly: boolean;
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  defaultResolution: string;
  maxReferenceVideoPlusOutputDurationSec?: number;
}

export interface UnsupportedVideoReferenceCapability {
  supported: false;
  reason: 'unsupported_model' | 'contract_unverified';
}

export type VideoReferenceCapability = SupportedVideoReferenceCapability | UnsupportedVideoReferenceCapability;

export interface VideoReferenceValidationInput {
  id: string;
  kind: VideoReferenceKind;
  mimeType: string;
  byteSize: number | null;
  durationSec?: number | null;
}

export interface VideoReferenceValidationRequest {
  providerType: string;
  model: string;
  references: readonly VideoReferenceValidationInput[];
  durationSec: number;
  aspectRatio?: string;
  resolution?: string;
}

const MIB = 1024 * 1024;
const COMPANY_REFERENCE_TOTAL_SEC = 15;
const SEEDANCE_REFERENCE_MODELS: readonly string[] = [SEEDANCE_20, SEEDANCE_FAST, SEEDANCE_25];

function companyReferenceCapability(model: string): SupportedVideoReferenceCapability | null {
  const contract = companyNativeVideoModel(model);
  if (!contract) return null;
  const mediaDuration = {
    minDurationSec: contract.referenceMinDurationSec,
    maxDurationSec: COMPANY_REFERENCE_TOTAL_SEC,
    maxTotalDurationSec: COMPANY_REFERENCE_TOTAL_SEC,
  };
  return {
    supported: true,
    image: {
      maxCount: contract.referenceImageCount,
      mimeTypes: ['image/jpeg', 'image/png'],
      maxBytes: 10 * MIB,
    },
    video: {
      maxCount: contract.referenceMediaCount,
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxBytes: contract.referenceVideoMaxBytes,
      ...mediaDuration,
    },
    audio: {
      maxCount: contract.referenceMediaCount,
      mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav'],
      maxBytes: 15 * MIB,
      ...mediaDuration,
    },
    allowsAudioOnly: true,
    aspectRatios: contract.aspectRatios,
    resolutions: contract.resolutions,
    defaultResolution: contract.resolution,
    ...(model === 'wan-3.0' ? { maxReferenceVideoPlusOutputDurationSec: 30 } : {}),
  };
}

function seedanceReferenceCapability(model: string): SupportedVideoReferenceCapability | null {
  if (!SEEDANCE_REFERENCE_MODELS.includes(model)) return null;
  const contract = seedanceContract(model)!;
  const is25 = model === SEEDANCE_25;
  return {
    supported: true,
    image: {
      maxCount: contract.imageCount,
      mimeTypes: is25
        ? ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif', 'image/heic', 'image/heif']
        : ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: 30 * MIB,
    },
    video: {
      maxCount: contract.mediaCount,
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxBytes: 200 * MIB,
      minDurationSec: 2,
      maxDurationSec: contract.maxDuration,
      maxTotalDurationSec: contract.maxDuration,
    },
    audio: {
      maxCount: contract.mediaCount,
      mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav'],
      maxBytes: 15 * MIB,
      minDurationSec: 2,
      maxDurationSec: contract.maxDuration,
      maxTotalDurationSec: contract.maxDuration,
    },
    allowsAudioOnly: is25,
    aspectRatios: SEEDANCE_REFERENCE_ASPECT_RATIOS,
    resolutions: contract.resolutions,
    defaultResolution: String(seedanceOutputFields(model, {}).resolution),
  };
}

/** Browser-safe exact model decision; callers must not infer reference support from aliases. */
export function videoReferenceCapability(providerType: string, model: string): VideoReferenceCapability {
  const capability = providerType === 'openai-video'
    ? companyReferenceCapability(model) ?? seedanceReferenceCapability(model)
    : providerType === 'jimeng' ? seedanceReferenceCapability(model) : null;
  if (capability) return capability;
  return {
    supported: false,
    reason: providerType === 'openai-video' ? 'contract_unverified' : 'unsupported_model',
  };
}

/** Pure preflight shared by future API/queue callers; null byteSize means delivery already checked it. */
export function validateVideoReferenceRequest(request: VideoReferenceValidationRequest): string[] {
  const capability = videoReferenceCapability(request.providerType, request.model);
  if (!capability.supported) return [`模型 ${request.model} 不支持全能参考`];
  const problems: string[] = [];
  const durationError = videoDurationError(request.providerType, request.model, request.durationSec);
  if (durationError) problems.push(durationError);
  if (request.aspectRatio !== undefined && !capability.aspectRatios.includes(request.aspectRatio)) {
    problems.push(`输出比例 ${request.aspectRatio} 不受支持`);
  }
  if (request.resolution !== undefined && !capability.resolutions.includes(request.resolution)) {
    problems.push(`输出清晰度 ${request.resolution} 不受支持`);
  }
  if (request.references.length === 0) problems.push('全能参考至少需要一份素材');

  for (const kind of ['image', 'video', 'audio'] as const) {
    const rule = capability[kind];
    const references = request.references.filter((reference) => reference.kind === kind);
    if (references.length > rule.maxCount) {
      problems.push(`参考${kind}最多 ${rule.maxCount} 份`);
    }
    for (const reference of references) {
      if (!rule.mimeTypes.includes(reference.mimeType)) {
        problems.push(`参考 ${reference.id} 的 MIME ${reference.mimeType} 不受支持`);
      }
      if (reference.byteSize !== null) {
        if (!Number.isFinite(reference.byteSize) || reference.byteSize < 0) {
          problems.push(`参考 ${reference.id} 的文件大小无效`);
        } else if (reference.byteSize > rule.maxBytes) {
          problems.push(`参考 ${reference.id} 超过 ${Math.round(rule.maxBytes / MIB)} MiB 上限`);
        }
      }
      if (kind === 'image') continue;
      const duration = reference.durationSec;
      if (duration === null || duration === undefined || !Number.isFinite(duration) || duration <= 0) {
        problems.push(`参考 ${reference.id} 缺少有效时长`);
      } else if (duration < rule.minDurationSec! || duration > rule.maxDurationSec!) {
        problems.push(`参考 ${reference.id} 每段须为 ${rule.minDurationSec}–${rule.maxDurationSec} 秒`);
      }
    }
    if (kind !== 'image') {
      const total = references.reduce((sum, reference) => sum + (reference.durationSec ?? 0), 0);
      if (total > rule.maxTotalDurationSec!) {
        problems.push(`参考${kind}分类总时长不能超过 ${rule.maxTotalDurationSec} 秒`);
      }
    }
  }

  const hasAudio = request.references.some((reference) => reference.kind === 'audio');
  const hasVisual = request.references.some((reference) => reference.kind === 'image' || reference.kind === 'video');
  if (hasAudio && !hasVisual && !capability.allowsAudioOnly) {
    problems.push('参考音频必须搭配图片或视频');
  }
  if (capability.maxReferenceVideoPlusOutputDurationSec !== undefined) {
    const videoTotal = request.references
      .filter((reference) => reference.kind === 'video')
      .reduce((sum, reference) => sum + (reference.durationSec ?? 0), 0);
    if (videoTotal + request.durationSec > capability.maxReferenceVideoPlusOutputDurationSec) {
      problems.push(`输入视频加输出不能超过 ${capability.maxReferenceVideoPlusOutputDurationSec} 秒`);
    }
  }
  return problems;
}
