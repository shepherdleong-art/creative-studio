import { companyImageCellExecutable } from '../../company-gateway-size.ts';
import { GPT_IMAGE_2_ASPECT_RATIOS, resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';

export const UNIFIED_MEDIA_RULE_VERSION = 'unified-media-2026-11-10-v1';
export const UNIFIED_IMAGE_MODEL_KEY = 'image2' as const;
export const UNIFIED_IMAGE_ANCHOR_ID = 'unified-image2' as const;
export const UNIFIED_IMAGE_DISPLAY_NAME = 'Image 2' as const;
export const UNIFIED_KLING3_MODEL_KEY = 'kling-3.0' as const;
export const UNIFIED_KLING3_ANCHOR_ID = 'unified-kling-3' as const;
export const UNIFIED_KLING3_DISPLAY_NAME = '可灵 3.0' as const;

export type UnifiedImageTier = '1k' | '2k' | '4k';
export type UnifiedImageChannelKey = 'qiniu' | 'tencent';
export type UnifiedVideoChannelKey = 'qiniu' | 'tencent';

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

export interface UnifiedVideoChannelDefinition {
  channelKey: UnifiedVideoChannelKey;
  providerTable: 'video_providers';
  providerId: string;
  model: string;
  priority: number;
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

export const UNIFIED_KLING3_CHANNELS: readonly UnifiedVideoChannelDefinition[] = Object.freeze([
  Object.freeze({
    channelKey: 'qiniu',
    providerTable: 'video_providers',
    providerId: 'company-qiniuyun-kling-3-0',
    model: 'qiniuyun/kling-3.0',
    priority: 0,
  }),
  Object.freeze({
    channelKey: 'tencent',
    providerTable: 'video_providers',
    providerId: 'company-kling-3-0',
    model: 'kling-3.0',
    priority: 1,
  }),
] as const);

const CANDIDATE_TIERS: readonly UnifiedImageTier[] = ['1k', '2k', '4k'];
const CANDIDATE_RATIOS = GPT_IMAGE_2_ASPECT_RATIOS.filter((ratio) => ratio !== 'auto');

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
export function trustedUnifiedModelForChannelModel(
  value: unknown,
): typeof UNIFIED_IMAGE_MODEL_KEY | typeof UNIFIED_KLING3_MODEL_KEY | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (UNIFIED_IMAGE_CHANNELS.some((channel) => channel.model === model)) return UNIFIED_IMAGE_MODEL_KEY;
  if (UNIFIED_KLING3_CHANNELS.some((channel) => channel.model === model)) return UNIFIED_KLING3_MODEL_KEY;
  return null;
}

export function trustedChannelModelsForUnifiedModel(value: unknown): string[] {
  if (value === UNIFIED_IMAGE_MODEL_KEY) return UNIFIED_IMAGE_CHANNELS.map((channel) => channel.model);
  if (value === UNIFIED_KLING3_MODEL_KEY) return UNIFIED_KLING3_CHANNELS.map((channel) => channel.model);
  return [];
}

export function unifiedMediaDisplayName(value: unknown): string | null {
  if (value === UNIFIED_IMAGE_MODEL_KEY) return UNIFIED_IMAGE_DISPLAY_NAME;
  if (value === UNIFIED_KLING3_MODEL_KEY) return UNIFIED_KLING3_DISPLAY_NAME;
  return null;
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

/** New team tasks must use the anchor; exact channel rows are recovery-only. */
export function isUnifiedImageChannelProvider(provider: {
  id?: unknown;
  model?: unknown;
}): boolean {
  const id = typeof provider.id === 'string' ? provider.id.trim() : '';
  const model = typeof provider.model === 'string' ? provider.model.trim() : '';
  return UNIFIED_IMAGE_CHANNELS.some((channel) => channel.providerId === id || channel.model === model);
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

export function isUnifiedKlingAnchorProvider(provider: {
  id?: unknown;
  type?: unknown;
  defaultModel?: unknown;
  model?: unknown;
}): boolean {
  const model = provider.defaultModel ?? provider.model;
  return provider.id === UNIFIED_KLING3_ANCHOR_ID
    && provider.type === 'openai-video'
    && model === UNIFIED_KLING3_MODEL_KEY;
}

export function isUnifiedKlingChannelProvider(provider: {
  id?: unknown;
  defaultModel?: unknown;
  model?: unknown;
}): boolean {
  const id = typeof provider.id === 'string' ? provider.id.trim() : '';
  if (id === UNIFIED_KLING3_ANCHOR_ID) return false;
  const model = typeof (provider.defaultModel ?? provider.model) === 'string'
    ? String(provider.defaultModel ?? provider.model).trim()
    : '';
  return UNIFIED_KLING3_CHANNELS.some((channel) => channel.providerId === id || channel.model === model);
}

export function unifiedKlingAnchorProjection(available: boolean) {
  return {
    id: UNIFIED_KLING3_ANCHOR_ID,
    name: UNIFIED_KLING3_DISPLAY_NAME,
    defaultModel: UNIFIED_KLING3_MODEL_KEY,
    defaultDurationSec: 5,
    category: 'video',
    type: 'openai-video',
    enabled: 1,
    configured: available,
    hasApiKey: available,
    missing: available ? [] : ['可灵 3.0 通道'],
    unified: true,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
  };
}
