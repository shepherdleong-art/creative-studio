import { GPT_IMAGE_2_SIZE_MAP, resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';
import {
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  normalizeUnifiedImageTier,
  unifiedImageCompatibleChannels,
  type UnifiedImageTier,
} from './catalog.ts';

export class UnifiedImageRequestError extends Error {
  readonly code: 'invalid_unified_image_request' | 'unsupported_image_combination';

  constructor(code: UnifiedImageRequestError['code'], message: string) {
    super(message);
    this.name = 'UnifiedImageRequestError';
    this.code = code;
  }
}

export interface UnifiedImageFreezeInput {
  inputImageId: string;
  referenceImageIds: string[];
  prompt: string;
  tier: unknown;
  ratio: unknown;
  referenceGuidanceMode: 'preserve_subject' | 'none';
}

export interface FrozenUnifiedImageRequest {
  unifiedModel: typeof UNIFIED_IMAGE_MODEL_KEY;
  ruleVersion: typeof UNIFIED_MEDIA_RULE_VERSION;
  inputImageId: string;
  referenceImageIds: string[];
  prompt: string;
  tier: UnifiedImageTier;
  ratio: string;
  size: string;
  quality: 'auto';
  referenceGuidanceMode: 'preserve_subject' | 'none';
}

export function resolveUnifiedImageOutput(
  tierValue: unknown,
  ratioValue: unknown,
): { tier: UnifiedImageTier; ratio: string; size: string } {
  const tier = normalizeUnifiedImageTier(tierValue);
  if (!tier) throw new UnifiedImageRequestError('invalid_unified_image_request', '清晰度必须是 1k、2k 或 4k。');
  const ratio = typeof ratioValue === 'string' ? ratioValue.trim() : '';
  if (!ratio) throw new UnifiedImageRequestError('invalid_unified_image_request', '画面比例不能为空。');
  if (unifiedImageCompatibleChannels(tier, ratio).length === 0) {
    throw new UnifiedImageRequestError(
      'unsupported_image_combination',
      `当前没有 Image 2 通道支持 ${tier.toUpperCase()} + ${ratio}，请调整清晰度或比例。`,
    );
  }
  return { tier, ratio, size: resolveGptImage2Size(ratio, tier) };
}

export function freezeUnifiedImageRequest(input: UnifiedImageFreezeInput): FrozenUnifiedImageRequest {
  const inputImageId = String(input.inputImageId ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  if (!inputImageId) throw new UnifiedImageRequestError('invalid_unified_image_request', '统一图片任务缺少输入图。');
  if (!prompt) throw new UnifiedImageRequestError('invalid_unified_image_request', '统一图片任务缺少提示词。');
  const referenceImageIds = Array.isArray(input.referenceImageIds)
    ? input.referenceImageIds.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];
  if (referenceImageIds.length !== (Array.isArray(input.referenceImageIds) ? input.referenceImageIds.length : 0)) {
    throw new UnifiedImageRequestError('invalid_unified_image_request', '统一图片任务的参考图顺序包含空身份。');
  }
  const { tier, ratio, size } = resolveUnifiedImageOutput(input.tier, input.ratio);
  return {
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
    inputImageId,
    referenceImageIds,
    prompt,
    tier,
    ratio,
    size,
    quality: 'auto',
    referenceGuidanceMode: input.referenceGuidanceMode === 'none' ? 'none' : 'preserve_subject',
  };
}

export function inferUnifiedImageOutputFromPreset(size: unknown): { tier: UnifiedImageTier; ratio: string } | null {
  if (typeof size !== 'string' || !size.trim()) return null;
  const target = size.trim();
  for (const [ratio, byTier] of Object.entries(GPT_IMAGE_2_SIZE_MAP)) {
    for (const [tier, preset] of Object.entries(byTier)) {
      const normalizedTier = normalizeUnifiedImageTier(tier);
      if (preset === target && normalizedTier) return { tier: normalizedTier, ratio };
    }
  }
  return null;
}
