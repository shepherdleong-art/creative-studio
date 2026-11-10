import {
  normalizeUnifiedImageTier,
  unifiedImageCatalogCombinations,
  unifiedImageResolutionsForRatio,
} from '../media-core/unified-media/catalog.ts';
import { COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY } from './adapters/company-capabilities.ts';

export function canvasParameterOptions(
  capabilityKey: string | null | undefined,
  parameterKey: string,
  declaredOptions: readonly string[] | undefined,
  parameters: Record<string, string | number | boolean>,
): readonly string[] {
  if (capabilityKey !== COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key) {
    return declaredOptions ?? [];
  }
  if (parameterKey === 'aspectRatio') {
    const tier = normalizeUnifiedImageTier(parameters.resolution) ?? '2k';
    return [...new Set(unifiedImageCatalogCombinations()
      .filter((combination) => combination.tier === tier)
      .map((combination) => combination.ratio))];
  }
  if (parameterKey === 'resolution') {
    const ratio = typeof parameters.aspectRatio === 'string' ? parameters.aspectRatio : '1:1';
    return unifiedImageResolutionsForRatio(ratio).map((tier) => tier.toUpperCase());
  }
  return declaredOptions ?? [];
}

export function updateCanvasParameter(
  capabilityKey: string | null | undefined,
  parameters: Record<string, string | number | boolean>,
  key: 'aspectRatio' | 'resolution',
  value: string,
): Record<string, string | number | boolean> {
  const next = { ...parameters, [key]: value };
  if (capabilityKey !== COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key) return next;
  if (key === 'aspectRatio') {
    const valid = unifiedImageResolutionsForRatio(value).map((tier) => tier.toUpperCase());
    if (!valid.includes(String(next.resolution ?? ''))) {
      next.resolution = valid[0] ?? '2K';
    }
  } else {
    const tier = normalizeUnifiedImageTier(value);
    const validRatios = tier
      ? new Set(unifiedImageCatalogCombinations()
        .filter((combination) => combination.tier === tier)
        .map((combination) => combination.ratio))
      : new Set<string>();
    if (!validRatios.has(String(next.aspectRatio ?? ''))) {
      next.aspectRatio = [...validRatios][0] ?? '1:1';
    }
  }
  return next;
}
