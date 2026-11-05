import {
  decideVideoGenerationMode,
  videoTailFrameDraftState,
  type VideoGenerationModeValue,
} from './video-auto-mode.ts';
import { normalizeVideoDraftDuration, videoDurationOptions } from './video-duration.ts';
import type { TailFrameCapability } from './video-providers/types.ts';
import type { VideoReferenceCapability } from './video-reference-contract.ts';

/** Serializable server decision; browser callers never infer capabilities from model names. */
export interface VideoModelCapabilities {
  durations: readonly number[];
  tailFrame: TailFrameCapability;
  multiShot: { supported: boolean; defaultEnabled: boolean };
  reference: VideoReferenceCapability;
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
  /**
   * H3/Wan 自动模式（规格 §6）需要看到草稿里尾帧的真实状态；
   * 只看 `tailImageId` 会把「上传中/失败」误当成「没有尾帧」而偷偷降级。
   */
  tailImageId?: string | null;
  tailUploadState?: 'idle' | 'uploading' | 'failed' | 'deleting' | null;
  /**
   * 非自动模式模型仍然遵守调用方显式选择的模式；自动模式模型永远忽略它。
   */
  generationMode?: VideoGenerationModeValue | null;
}

// No provider selected: retain the historical draft duration choices, never enable tail frames.
const UNSELECTED_CAPABILITIES: VideoModelCapabilities = {
  durations: videoDurationOptions('', ''),
  tailFrame: { supported: false, reason: 'unsupported_model' },
  multiShot: { supported: false, defaultEnabled: false },
  reference: { supported: false, reason: 'unsupported_model' },
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
  const preferred = configured.find((provider) => provider.defaultModel === 'kling-2.5')
    ?? configured.find((provider) =>
      /kling/i.test(provider.defaultModel) || /kling/i.test(provider.name),
    ) ?? configured[0];
  const providerId = draft.providerId || bulkProviderId || preferred?.id || '';
  const provider = providers.find((item) => item.id === providerId);
  // Older responses may predate the snapshot. Preserve their duration rules and legacy
  // fields; in particular never infer a tail-frame protocol from a model name here.
  const capabilities = provider?.capabilities
    ? { ...provider.capabilities, reference: provider.capabilities.reference ?? UNSELECTED_CAPABILITIES.reference }
    : provider ? {
      durations: videoDurationOptions(provider.type ?? '', provider.defaultModel),
      tailFrame: provider.tailFrameCapability ?? UNSELECTED_CAPABILITIES.tailFrame,
      multiShot: provider.multiShotCapability ?? UNSELECTED_CAPABILITIES.multiShot,
      reference: UNSELECTED_CAPABILITIES.reference,
    } : UNSELECTED_CAPABILITIES;
  // Preserve the panel's five-second starting point, independent of settings defaults.
  const durationSec = normalizeVideoDraftDuration(draft.durationSec ?? 5, capabilities.durations);
  const multiShot = draft.multiShot ?? capabilities.multiShot.defaultEnabled;
  // 规格 §6：H3/Wan 只有单图时自动 reference、有有效尾帧时自动首尾帧、
  // 尾帧操作未完成时阻止提交。其余模型沿用既有显式模式。
  const modeDecision = decideVideoGenerationMode({
    providerType: provider?.type ?? null,
    model: provider?.defaultModel ?? null,
    tailFrameState: videoTailFrameDraftState({
      tailImageId: draft.tailImageId ?? null,
      uploadState: draft.tailUploadState ?? 'idle',
    }),
    explicitMode: draft.generationMode ?? null,
  });
  return {
    providerId,
    generationMode: modeDecision.generationMode,
    /** 自动模式（H3/Wan）标记：UI 据此展示双卡片与单图/首尾帧提示。 */
    automaticMode: modeDecision.automatic,
    /**
     * 尾帧草稿不可提交（上传中/删除中/失败）。
     * 这是 UI 行级校验的输入信号（见 video-tail-frame-state 的 automaticMode 分支），
     * 由 `video-auto-mode.test.ts` / `video-model-capabilities.test.ts` 锁住；不要删。
     */
    modeBlocked: modeDecision.blocked,
    capabilities,
    durationSec,
    requestOptions: {
      durationSec,
      ...(capabilities.multiShot.supported ? { multiShot } : {}),
    },
  };
}

