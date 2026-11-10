import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} from './catalog.ts';
import {
  UnifiedImageRequestError,
  freezeUnifiedImageRequest,
  inferUnifiedImageOutputFromPreset,
  type FrozenUnifiedImageRequest,
} from './requests.ts';

export interface UnifiedImageJobContract {
  providerId: typeof UNIFIED_IMAGE_ANCHOR_ID;
  model: typeof UNIFIED_IMAGE_MODEL_KEY;
  size: string;
  quality: 'auto';
  maxAttempts: 1;
  unifiedModel: typeof UNIFIED_IMAGE_MODEL_KEY;
  unifiedRuleVersion: typeof UNIFIED_MEDIA_RULE_VERSION;
  unifiedRequestJson: string;
  frozen: FrozenUnifiedImageRequest;
}

export interface UnifiedImageJobInput {
  projectSize: unknown;
  prompt: unknown;
  inputImageId: unknown;
  referenceImageIds: unknown;
  referenceGuidanceMode?: unknown;
}

function references(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim());
}

function guidance(value: unknown): 'preserve_subject' | 'none' {
  return value === 'none' ? 'none' : 'preserve_subject';
}

/**
 * Freeze one ordinary-project Image 2 task from the project's locked output
 * preset. Every submission point uses this helper so batch creation and
 * regeneration cannot drift from the queue's executable-combination contract.
 */
export function buildUnifiedImageJobContract(input: UnifiedImageJobInput): UnifiedImageJobContract {
  const output = inferUnifiedImageOutputFromPreset(input.projectSize);
  if (!output) {
    throw new UnifiedImageRequestError(
      'invalid_unified_image_request',
      '项目的清晰度与比例不是有效的 Image 2 输出组合。',
    );
  }
  const frozen = freezeUnifiedImageRequest({
    inputImageId: String(input.inputImageId ?? ''),
    referenceImageIds: references(input.referenceImageIds),
    prompt: String(input.prompt ?? ''),
    tier: output.tier,
    ratio: output.ratio,
    referenceGuidanceMode: guidance(input.referenceGuidanceMode),
  });
  return {
    providerId: UNIFIED_IMAGE_ANCHOR_ID,
    model: UNIFIED_IMAGE_MODEL_KEY,
    size: frozen.size,
    quality: 'auto',
    maxAttempts: 1,
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
    unifiedRequestJson: JSON.stringify(frozen),
    frozen,
  };
}

export function isUnifiedImageJobProvider(provider: {
  id?: unknown;
  type?: unknown;
  model?: unknown;
}): boolean {
  return provider.id === UNIFIED_IMAGE_ANCHOR_ID
    && provider.type === 'unified-image'
    && provider.model === UNIFIED_IMAGE_MODEL_KEY;
}

export function unifiedImageProjectReferenceGuidance(value: unknown): 'preserve_subject' | 'none' {
  return guidance(value);
}
