// Server entry point: importing adapters here must never pull them into the UI bundle.
import { getVideoAdapter } from './video-providers/index.ts';
import type { TailFrameCapability } from './video-providers/types.ts';
import { videoDurationOptions } from './video-duration.ts';
import { isCompanyKlingMultiShotTarget } from './video-multi-shot.ts';
import { resolveVideoProviderRuntimeConfig, type VideoProviderEnvConfig } from './video-auth.ts';
import type { VideoModelCapabilities } from './video-generation-options.ts';

export function getVideoTailFrameCapability(providerType: string, model: string): TailFrameCapability {
  return getVideoAdapter(providerType)?.tailFrameCapability?.(model) ?? {
    supported: false,
    reason: providerType === 'openai-video' ? 'contract_unverified' : 'unsupported_model',
  };
}

export function getVideoModelCapabilities(providerType: string, model: string): VideoModelCapabilities {
  const multiShot = isCompanyKlingMultiShotTarget(providerType, model);
  return {
    durations: videoDurationOptions(providerType, model),
    tailFrame: getVideoTailFrameCapability(providerType, model),
    multiShot: { supported: multiShot, defaultEnabled: multiShot },
  };
}

/** Shared collection/item projection: resolve the actual model once and never expose credentials. */
export function describeVideoProvider(provider: VideoProviderEnvConfig) {
  const runtime = resolveVideoProviderRuntimeConfig(provider);
  const capabilities = getVideoModelCapabilities(provider.type, runtime.model);
  return {
    id: provider.id,
    name: provider.name,
    category: 'video',
    type: provider.type,
    baseUrl: runtime.baseUrl,
    defaultModel: runtime.model,
    defaultDurationSec: runtime.durationSec,
    enabled: provider.enabled,
    configured: runtime.configured,
    missing: runtime.missing,
    hasApiKey: runtime.hasApiKey,
    capabilities,
    // Keep the existing response contract for settings and other clients.
    tailFrameCapability: capabilities.tailFrame,
    ...(capabilities.multiShot.supported ? { multiShotCapability: capabilities.multiShot } : {}),
  };
}
