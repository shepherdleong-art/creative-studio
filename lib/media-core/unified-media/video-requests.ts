import { companyVideoCapsForModel } from '../../company-gateway-size.ts';
import { videoDurationError } from '../../video-duration.ts';
import {
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  type UnifiedVideoChannelDefinition,
} from './catalog.ts';

export const UNIFIED_KLING3_MIN_DURATION_SEC = 3;
export const UNIFIED_KLING3_MAX_DURATION_SEC = 15;

export type UnifiedKlingGenerationMode = 'image-to-video';

export interface UnifiedKlingVideoFreezeInput {
  sourceImageId: string;
  tailImageId: string | null;
  referenceAssetIds: string[];
  prompt: string;
  durationSec: number;
  generationMode: string;
  multiShot: unknown;
  aspectRatio: string | null;
  resolution: string | null;
}

export interface FrozenUnifiedKlingVideoRequest {
  unifiedModel: typeof UNIFIED_KLING3_MODEL_KEY;
  ruleVersion: typeof UNIFIED_MEDIA_RULE_VERSION;
  sourceImageId: string;
  tailImageId: string | null;
  referenceAssetIds: string[];
  prompt: string;
  durationSec: number;
  generationMode: UnifiedKlingGenerationMode;
  multiShot: boolean | null;
  aspectRatio: string | null;
  resolution: string | null;
}

export class UnifiedKlingRequestError extends Error {
  readonly code:
    | 'invalid_unified_kling_request'
    | 'unsupported_kling_mode'
    | 'unsupported_kling_combination';

  constructor(code: UnifiedKlingRequestError['code'], message: string) {
    super(message);
    this.name = 'UnifiedKlingRequestError';
    this.code = code;
  }
}

function normalizedOptional(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedResolution(value: unknown): string | null {
  const normalized = normalizedOptional(value);
  return normalized ? normalized.toUpperCase() : null;
}

export function unifiedKlingChannelSupports(
  channel: UnifiedVideoChannelDefinition,
  request: Pick<
    FrozenUnifiedKlingVideoRequest,
    'durationSec' | 'generationMode' | 'multiShot' | 'aspectRatio' | 'resolution' | 'tailImageId'
  >,
): boolean {
  if (request.generationMode !== 'image-to-video') return false;
  if (videoDurationError('openai-video', channel.model, request.durationSec)) return false;
  if (request.multiShot !== null && typeof request.multiShot !== 'boolean') return false;
  const caps = companyVideoCapsForModel(channel.model);
  if (!caps) return false;
  if (request.aspectRatio && !caps.ratios.includes(request.aspectRatio)) return false;
  if (request.resolution && !caps.tiers.includes(request.resolution)) return false;
  // 腾讯可灵尾帧的原生 OutputConfig 只做过 1080P 级样例；4K 尾帧没有可信
  // 上游证据，不能按“支持 4K”推断后静默落回 1080P。
  if (request.tailImageId && request.resolution === '4K') return false;
  // Both exact company Kling aliases have a verified tail-frame protocol and
  // intelligent-storyboard flag. A tail image changes only the channel field,
  // never the business contract.
  if (request.tailImageId && !channel.model.toLowerCase().includes('kling')) return false;
  return true;
}

export function unifiedKlingCompatibleChannels(
  request: FrozenUnifiedKlingVideoRequest,
): UnifiedVideoChannelDefinition[] {
  return UNIFIED_KLING3_CHANNELS
    .filter((channel) => unifiedKlingChannelSupports(channel, request))
    .sort((left, right) => left.priority - right.priority);
}

export function freezeUnifiedKlingVideoRequest(
  input: UnifiedKlingVideoFreezeInput,
): FrozenUnifiedKlingVideoRequest {
  const sourceImageId = String(input.sourceImageId ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  if (!sourceImageId) {
    throw new UnifiedKlingRequestError('invalid_unified_kling_request', '统一可灵任务缺少首帧图片。');
  }
  if (!prompt) {
    throw new UnifiedKlingRequestError('invalid_unified_kling_request', '统一可灵任务缺少视频提示词。');
  }
  if (input.generationMode !== 'image-to-video') {
    throw new UnifiedKlingRequestError(
      'unsupported_kling_mode',
      '当前可灵 3.0 统一入口只开放图生视频（首帧＋可选尾帧），任务未提交。',
    );
  }
  if (!Number.isSafeInteger(input.durationSec)) {
    throw new UnifiedKlingRequestError('invalid_unified_kling_request', '视频时长必须是整数秒。');
  }
  if (input.durationSec < UNIFIED_KLING3_MIN_DURATION_SEC
    || input.durationSec > UNIFIED_KLING3_MAX_DURATION_SEC) {
    throw new UnifiedKlingRequestError(
      'unsupported_kling_combination',
      `可灵 3.0 时长须为 ${UNIFIED_KLING3_MIN_DURATION_SEC}–${UNIFIED_KLING3_MAX_DURATION_SEC} 秒。`,
    );
  }
  const referenceAssetIds = Array.isArray(input.referenceAssetIds)
    ? input.referenceAssetIds.map((id) => String(id ?? '').trim())
    : [];
  if (referenceAssetIds.length > 0) {
    throw new UnifiedKlingRequestError(
      'unsupported_kling_mode',
      '可灵 3.0 统一入口不接受全能参考素材；请使用首帧/尾帧或选择其他视频模型。',
    );
  }
  if (input.multiShot !== undefined && input.multiShot !== null
    && typeof input.multiShot !== 'boolean') {
    throw new UnifiedKlingRequestError('invalid_unified_kling_request', '智能分镜必须明确开启或关闭。');
  }
  const multiShot = input.multiShot === undefined ? null : input.multiShot as boolean | null;
  const frozen: FrozenUnifiedKlingVideoRequest = {
    unifiedModel: UNIFIED_KLING3_MODEL_KEY,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
    sourceImageId,
    tailImageId: normalizedOptional(input.tailImageId),
    referenceAssetIds,
    prompt,
    durationSec: input.durationSec,
    generationMode: 'image-to-video',
    multiShot,
    aspectRatio: normalizedOptional(input.aspectRatio),
    resolution: normalizedResolution(input.resolution),
  };
  if (unifiedKlingCompatibleChannels(frozen).length === 0) {
    throw new UnifiedKlingRequestError(
      'unsupported_kling_combination',
      '当前没有可灵 3.0 通道同时支持这组时长、比例、清晰度、首尾帧和智能分镜要求。',
    );
  }
  return frozen;
}

export function unifiedKlingFrozenRequestMatchesJob(
  request: FrozenUnifiedKlingVideoRequest,
  job: {
    sourceImageId: string;
    tailImageId: string | null;
    prompt: string;
    durationSec: number;
    generationMode: string;
    multiShot: number | null;
    aspectRatio: string | null;
    resolution: string | null;
  },
): boolean {
  const storedMultiShot = job.multiShot === 1 ? true : job.multiShot === 0 ? false : null;
  return request.sourceImageId === job.sourceImageId
    && request.tailImageId === job.tailImageId
    && request.prompt === job.prompt
    && request.durationSec === job.durationSec
    && request.generationMode === job.generationMode
    && request.multiShot === storedMultiShot
    && request.aspectRatio === job.aspectRatio
    && request.resolution === job.resolution;
}
