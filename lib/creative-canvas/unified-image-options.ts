import {
  normalizeUnifiedImageTier,
  unifiedImageCatalogCombinations,
  unifiedImageResolutionsForRatio,
} from '../media-core/unified-media/catalog.ts';
import { UNIFIED_CANVAS_IMAGE2_CAPABILITY_KEY } from './unified-image-key.ts';
import type { CanvasImageCombination, CanvasModelCapability } from './capabilities.ts';

type CanvasImageParameterCapability = Pick<CanvasModelCapability, 'parameters'> & {
  imageCombinations?: readonly CanvasImageCombination[];
};

export function canvasParameterOptions(
  capabilityKey: string | null | undefined,
  parameterKey: string,
  declaredOptions: readonly string[] | undefined,
  parameters: Record<string, string | number | boolean>,
  capability?: CanvasImageParameterCapability | null,
): readonly string[] {
  if (capabilityKey !== UNIFIED_CANVAS_IMAGE2_CAPABILITY_KEY) {
    const combinations = capability?.imageCombinations;
    if (!combinations) return declaredOptions ?? [];
    if (parameterKey === 'aspectRatio') {
      const resolution = String(parameters.resolution
        ?? capability.parameters.find((parameter) => parameter.key === 'resolution')?.default ?? '2K');
      return (declaredOptions ?? []).filter((ratio) => combinations.some((combination) =>
        combination.resolution === resolution && combination.aspectRatio === ratio));
    }
    if (parameterKey === 'resolution') {
      const ratio = String(parameters.aspectRatio
        ?? capability.parameters.find((parameter) => parameter.key === 'aspectRatio')?.default ?? '1:1');
      return (declaredOptions ?? []).filter((tier) => combinations.some((combination) =>
        combination.resolution === tier && combination.aspectRatio === ratio));
    }
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
  capability?: CanvasImageParameterCapability | null,
): Record<string, string | number | boolean> {
  const next = { ...parameters, [key]: value };
  if (capabilityKey !== UNIFIED_CANVAS_IMAGE2_CAPABILITY_KEY) {
    if (!capability?.imageCombinations) return next;
    const dependentKey = key === 'aspectRatio' ? 'resolution' : 'aspectRatio';
    const declared = capability.parameters.find((parameter) => parameter.key === dependentKey)?.options;
    const valid = canvasParameterOptions(capabilityKey, dependentKey, declared, next, capability);
    if (!valid.includes(String(next[dependentKey] ?? ''))) {
      next[dependentKey] = valid[0] ?? (dependentKey === 'resolution' ? '2K' : '1:1');
    }
    return next;
  }
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
