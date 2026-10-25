import { normalizeVideoDraftDuration, videoDurationOptions } from './video-duration.ts';
import type { TailFrameCapability } from './video-providers/types.ts';

/** Serializable server decision; browser callers never infer capabilities from model names. */
export interface VideoModelCapabilities {
  durations: readonly number[];
  tailFrame: TailFrameCapability;
  multiShot: { supported: boolean; defaultEnabled: boolean };
}

export interface VideoGenerationProvider {
  id: string;
  name: string;
  defaultModel: string;
  type?: string;
  configured?: boolean;
  capabilities?: VideoModelCapabilities;
  tailFrameCapability?: TailFrameCapability;
  multiShotCapability?: VideoModelCapabilities['multiShot'];
}

interface VideoGenerationDraft {
  providerId: string;
  durationSec?: number;
  multiShot?: boolean;
}

// No provider selected: retain the historical draft duration choices, never enable tail frames.
const UNSELECTED_CAPABILITIES: VideoModelCapabilities = {
  durations: videoDurationOptions('', ''),
  tailFrame: { supported: false, reason: 'unsupported_model' },
  multiShot: { supported: false, defaultEnabled: false },
};

/**
 * Resolve selection, draft defaults and request fields together. Explicit provider choices
 * survive removal/disablement so validation can report them instead of changing models.
 * Draft correction is UI-only; server submissions still reject illegal durations.
 */
export function resolveVideoGenerationSelection(
  providers: readonly VideoGenerationProvider[],
  bulkProviderId: string,
  draft: VideoGenerationDraft,
) {
  const configured = providers.filter((provider) => provider.configured !== false);
  const preferred = configured.find((provider) =>
    /kling/i.test(provider.defaultModel) || /kling/i.test(provider.name),
  ) ?? configured[0];
  const providerId = draft.providerId || bulkProviderId || preferred?.id || '';
  const provider = providers.find((item) => item.id === providerId);
  // Older responses may predate the snapshot. Preserve their duration rules and legacy
  // fields; in particular never infer a tail-frame protocol from a model name here.
  const capabilities = provider?.capabilities ?? (provider ? {
    durations: videoDurationOptions(provider.type ?? '', provider.defaultModel),
    tailFrame: provider.tailFrameCapability ?? UNSELECTED_CAPABILITIES.tailFrame,
    multiShot: provider.multiShotCapability ?? UNSELECTED_CAPABILITIES.multiShot,
  } : UNSELECTED_CAPABILITIES);
  // Preserve the panel's five-second starting point, independent of settings defaults.
  const durationSec = normalizeVideoDraftDuration(draft.durationSec ?? 5, capabilities.durations);
  const multiShot = draft.multiShot ?? capabilities.multiShot.defaultEnabled;
  return {
    providerId,
    capabilities,
    durationSec,
    requestOptions: {
      durationSec,
      ...(capabilities.multiShot.supported ? { multiShot } : {}),
    },
  };
}
