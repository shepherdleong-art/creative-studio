import { companyImageCellExecutable } from '../../company-gateway-size.ts';
import { resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';

export const UNIFIED_MEDIA_RULE_VERSION = 'unified-media-2026-11-10-v1';
export const UNIFIED_IMAGE_MODEL_KEY = 'image2' as const;
export const UNIFIED_IMAGE_ANCHOR_ID = 'unified-image2' as const;
export const UNIFIED_IMAGE_DISPLAY_NAME = 'Image 2' as const;

export type UnifiedImageTier = '1k' | '2k' | '4k';
export type UnifiedImageChannelKey = 'qiniu' | 'tencent';

export interface UnifiedImageChannelDefinition {
  channelKey: UnifiedImageChannelKey;
  providerTable: 'providers';
  providerId: string;
  model: string;
  priority: number;
}

export interface UnifiedImageCombination {
  tier: UnifiedImageTier;
  ratio: string;
  size: string;
  channelKeys: UnifiedImageChannelKey[];
}

export const UNIFIED_IMAGE_CHANNELS: readonly UnifiedImageChannelDefinition[] = Object.freeze([
  Object.freeze({
    channelKey: 'qiniu',
    providerTable: 'providers',
    providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
    model: 'qiniuyun/gpt-image-2-medium',
    priority: 0,
  }),
  Object.freeze({
    channelKey: 'tencent',
    providerTable: 'providers',
    providerId: 'company-gateway-image2-medium',
    model: 'image2-medium',
    priority: 1,
  }),
] as const);

const CANDIDATE_TIERS: readonly UnifiedImageTier[] = ['1k', '2k', '4k'];
const CANDIDATE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'] as const;

export function normalizeUnifiedImageTier(value: unknown): UnifiedImageTier | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return CANDIDATE_TIERS.includes(normalized as UnifiedImageTier)
    ? normalized as UnifiedImageTier
    : null;
}

export function unifiedImageSupports(
  channel: UnifiedImageChannelDefinition,
  tier: UnifiedImageTier,
  ratio: string,
): boolean {
  return companyImageCellExecutable(channel.model, tier, ratio);
}

export function unifiedImageCompatibleChannels(
  tier: UnifiedImageTier,
  ratio: string,
): UnifiedImageChannelDefinition[] {
  return UNIFIED_IMAGE_CHANNELS
    .filter((channel) => unifiedImageSupports(channel, tier, ratio))
    .sort((left, right) => left.priority - right.priority);
}

export function unifiedImageCatalogCombinations(): UnifiedImageCombination[] {
  const combinations: UnifiedImageCombination[] = [];
  for (const tier of CANDIDATE_TIERS) {
    for (const ratio of CANDIDATE_RATIOS) {
      const channelKeys = unifiedImageCompatibleChannels(tier, ratio).map((channel) => channel.channelKey);
      if (channelKeys.length === 0) continue;
      combinations.push({ tier, ratio, size: resolveGptImage2Size(ratio, tier), channelKeys });
    }
  }
  return combinations;
}

export function unifiedImageAspectRatios(): string[] {
  return [...new Set(unifiedImageCatalogCombinations().map((combination) => combination.ratio))];
}

export function unifiedImageResolutionsForRatio(ratio: string): UnifiedImageTier[] {
  return unifiedImageCatalogCombinations()
    .filter((combination) => combination.ratio === ratio)
    .map((combination) => combination.tier);
}

/** Only exact trusted identities can inherit a unified authorization. */
export function trustedUnifiedModelForChannelModel(value: unknown): typeof UNIFIED_IMAGE_MODEL_KEY | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  return UNIFIED_IMAGE_CHANNELS.some((channel) => channel.model === model)
    ? UNIFIED_IMAGE_MODEL_KEY
    : null;
}

export function trustedChannelModelsForUnifiedModel(value: unknown): string[] {
  if (value !== UNIFIED_IMAGE_MODEL_KEY) return [];
  return UNIFIED_IMAGE_CHANNELS.map((channel) => channel.model);
}

export function unifiedMediaDisplayName(value: unknown): string | null {
  return value === UNIFIED_IMAGE_MODEL_KEY ? UNIFIED_IMAGE_DISPLAY_NAME : null;
}

export function isUnifiedImageAnchorProvider(provider: {
  id?: unknown;
  type?: unknown;
  model?: unknown;
}): boolean {
  return provider.id === UNIFIED_IMAGE_ANCHOR_ID
    && provider.type === 'unified-image'
    && provider.model === UNIFIED_IMAGE_MODEL_KEY;
}

export function unifiedImageAnchorProjection(available: boolean) {
  return {
    id: UNIFIED_IMAGE_ANCHOR_ID,
    name: UNIFIED_IMAGE_DISPLAY_NAME,
    model: UNIFIED_IMAGE_MODEL_KEY,
    type: 'unified-image',
    category: 'image',
    enabled: 1,
    configured: available,
    hasApiKey: available,
    missing: available ? [] : ['Image 2 通道'],
    unified: true,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
  };
}
