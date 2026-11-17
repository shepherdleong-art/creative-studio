import type { PackagingStickerInstance } from './packaging-stickers.ts';

export const PACKAGING_AUTO_LAYOUT_VERSION = 2 as const;
export const PACKAGING_LAYOUT_RUNTIME_BUNDLE_VERSION = 2 as const;

export type PackagingLayoutGenerationReason = 'initial' | 'explicit-reextract' | 'automatic-rebuild' | 'derived-version';
export type PackagingLayoutResolutionStatus = 'resolved' | 'stale' | 'unresolved';

export type PackagingLayoutVisualBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type PackagingLayoutElementResolution = {
  id: string;
  kind: 'sticker' | 'pointCue';
  centerXPct: number;
  centerYPct: number;
  positionPinned: boolean;
  fit?: Record<string, string | number>;
  visualBox?: PackagingLayoutVisualBox;
};

export type PackagingLayoutResolution = {
  schemaVersion: 1;
  status: PackagingLayoutResolutionStatus;
  inputHash: string;
  runtimeBundleVersion: number;
  geometryManifestHash: string;
  outputWidth: number;
  outputHeight: number;
  elements: Record<string, PackagingLayoutElementResolution>;
  validation: { frameCount: number; digest: string };
};

function assertVersion(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2) {
    throw new Error(`${label}包含不支持的布局版本`);
  }
}

/** 自动重建与既有版本派生只保留原版本，只有全新初始布局和显式重提升级为 v2。 */
export function resolvePointCuesLayoutVersion(
  previous: number | undefined,
  reason: PackagingLayoutGenerationReason,
): number | undefined {
  assertVersion(previous, '正文卖点');
  if (reason === 'initial' || reason === 'explicit-reextract') return PACKAGING_AUTO_LAYOUT_VERSION;
  return previous;
}

/** 任一新元素进入 v2 后整片使用 v2 bundle；删除元素不会静默降级共享资源。 */
export function resolveLayoutRuntimeBundleVersion(input: {
  previous?: number;
  pointCuesLayoutVersion?: number;
  stickers?: readonly PackagingStickerInstance[];
}): number | undefined {
  assertVersion(input.previous, '包装运行时');
  assertVersion(input.pointCuesLayoutVersion, '正文卖点');
  const hasV2 = input.pointCuesLayoutVersion === PACKAGING_AUTO_LAYOUT_VERSION
    || Boolean(input.stickers?.some((sticker) => sticker.origin.kind === 'auto' && sticker.origin.layoutVersion === PACKAGING_AUTO_LAYOUT_VERSION));
  if (input.previous === PACKAGING_LAYOUT_RUNTIME_BUNDLE_VERSION || hasV2) return PACKAGING_LAYOUT_RUNTIME_BUNDLE_VERSION;
  return input.previous;
}

export function isPotentiallyMovableV2Sticker(sticker: PackagingStickerInstance, stage: 'opening' | 'middle' | 'ending'): boolean {
  return stage !== 'ending' && sticker.origin.kind === 'auto'
    && sticker.origin.layoutVersion === PACKAGING_AUTO_LAYOUT_VERSION && sticker.origin.positionPinned !== true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeVisualBox(value: unknown): PackagingLayoutVisualBox | undefined {
  if (!isRecord(value) || !finite(value.left) || !finite(value.top) || !finite(value.right) || !finite(value.bottom)
    || value.right <= value.left || value.bottom <= value.top) return undefined;
  return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
}

/** Resolution 是可验证数据而非任意 JSON；非法项不进入预览或任务快照。 */
export function sanitizePackagingLayoutResolution(value: unknown): PackagingLayoutResolution | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1
    || (value.status !== 'resolved' && value.status !== 'stale' && value.status !== 'unresolved')
    || typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash)
    || typeof value.geometryManifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.geometryManifestHash)
    || !Number.isSafeInteger(value.runtimeBundleVersion) || !Number.isSafeInteger(value.outputWidth) || !Number.isSafeInteger(value.outputHeight)
    || (value.outputWidth as number) <= 0 || (value.outputHeight as number) <= 0
    || !isRecord(value.elements) || !isRecord(value.validation)
    || !Number.isSafeInteger(value.validation.frameCount) || (value.validation.frameCount as number) < 0
    || typeof value.validation.digest !== 'string') return undefined;
  const elements: PackagingLayoutResolution['elements'] = {};
  for (const [key, raw] of Object.entries(value.elements)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || !isRecord(raw) || raw.id !== key
      || (raw.kind !== 'sticker' && raw.kind !== 'pointCue')
      || !finite(raw.centerXPct) || !finite(raw.centerYPct)
      || raw.centerXPct < 0 || raw.centerXPct > 100 || raw.centerYPct < 0 || raw.centerYPct > 100) return undefined;
    const fit: Record<string, string | number> = {};
    if (raw.fit !== undefined) {
      if (!isRecord(raw.fit)) return undefined;
      for (const [fitKey, fitValue] of Object.entries(raw.fit)) {
        if (typeof fitValue !== 'string' && !finite(fitValue)) return undefined;
        fit[fitKey] = fitValue;
      }
    }
    const visualBox = raw.visualBox === undefined ? undefined : sanitizeVisualBox(raw.visualBox);
    if (raw.visualBox !== undefined && !visualBox) return undefined;
    elements[key] = {
      id: key,
      kind: raw.kind,
      centerXPct: raw.centerXPct,
      centerYPct: raw.centerYPct,
      positionPinned: raw.positionPinned === true,
      ...(Object.keys(fit).length ? { fit } : {}),
      ...(visualBox ? { visualBox } : {}),
    };
  }
  return {
    schemaVersion: 1,
    status: value.status,
    inputHash: value.inputHash,
    runtimeBundleVersion: value.runtimeBundleVersion as number,
    geometryManifestHash: value.geometryManifestHash,
    outputWidth: value.outputWidth as number,
    outputHeight: value.outputHeight as number,
    elements,
    validation: { frameCount: value.validation.frameCount as number, digest: value.validation.digest },
  };
}
