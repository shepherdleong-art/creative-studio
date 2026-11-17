'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FinalEditPackagingConfig, PackagingPointLayout } from '@/lib/media-core/packaging-vars';
import type { PackagingStickerInstance } from '@/lib/media-core/packaging-stickers';
import type { PackagingStickerAssetMap } from '@/lib/media-core/packaging-sticker-assets';

export function packagingDocumentConfig(config: FinalEditPackagingConfig | undefined) {
  return { ...config, layouts: undefined, layoutResolution: undefined,
    stickers: config?.stickers?.map(({ id, assetId, styleMode, fixedStyle, startFrame, endFrame, animation }) =>
      ({ id, assetId, styleMode, fixedStyle, startFrame, endFrame, animation })) };
}

type PreviewVars = { stickers?: PackagingStickerInstance[]; stickerAssets?: PackagingStickerAssetMap;
  layoutResolution?: FinalEditPackagingConfig['layoutResolution']; layouts?: FinalEditPackagingConfig['layouts'] };
type PreviewWindow = Window & {
  compositionVariables?: PreviewVars;
  __hyperframes?: { getVariables?: () => PreviewVars };
  __pointLayout?: { apply: (element: HTMLElement, layout: PackagingPointLayout | null) => void };
  __packagingStickerRuntime?: { computeStickerGeometry: (sticker: PackagingStickerInstance, asset: PackagingStickerAssetMap[string]) => { imageWidthPct: number } };
  __packagingAutoLayoutReplay?: { apply: () => boolean };
  __packagingStickerEditBridge?: { sync?: () => void; isDragging?: () => boolean };
};

/** 沿用 PR #14 的原地布局同步：保存、重算及历史恢复均不替换几何编辑所在的文档。 */
export function syncPackagingPreviewGeometry(frame: HTMLIFrameElement, config: FinalEditPackagingConfig): void {
  const win = frame.contentWindow as PreviewWindow | null;
  if (!win?.__pointLayout || win.__packagingStickerEditBridge?.isDragging?.()) return;
  const vars = win.compositionVariables ?? win.__hyperframes?.getVariables?.() ?? {};
  win.compositionVariables = vars;
  vars.layouts = config.layouts;
  vars.stickers = config.stickers;
  // 重算期间维持上次已验证的自动几何；手动位置由下面的实时布局桥覆盖。
  vars.layoutResolution = config.layoutResolution?.status === 'stale'
    ? { ...config.layoutResolution, status: 'resolved' } : config.layoutResolution;
  const layouts = config.layouts?.[config.template];
  win.document.querySelectorAll<HTMLElement>('[data-point-id]').forEach(element => {
    const id = element.dataset.pointId ?? '';
    const layout = id.startsWith('cover:') ? layouts?.cover?.[id.slice(6)] : layouts?.cues?.[id.slice(4)];
    if (layout || element.dataset.ul === '1') win.__pointLayout!.apply(element, layout ?? null);
  });
  const stickers = new Map((config.stickers ?? []).map(sticker => [sticker.id, sticker]));
  win.document.querySelectorAll<HTMLElement>('.packaging-sticker[data-sticker-id]').forEach(element => {
    const sticker = stickers.get(element.dataset.stickerId ?? '');
    const asset = sticker && vars.stickerAssets?.[sticker.id];
    if (!sticker || !asset || !win.__packagingStickerRuntime) return;
    const geometry = win.__packagingStickerRuntime.computeStickerGeometry(sticker, asset);
    const resolved = config.layoutResolution?.elements[sticker.id];
    // stale 保留上次已解析中心，手动固定位置始终来自已保存的配置。
    const center = sticker.origin.kind === 'auto' && !sticker.origin.positionPinned && resolved ? resolved : sticker;
    element.style.left = `${center.centerXPct}%`;
    element.style.top = `${center.centerYPct}%`;
    element.style.width = `${geometry.imageWidthPct}%`;
    // 首次保存可能归一化旧同轨项；与贴纸 runtime 相同的层级更新不需要更换文档。
    element.style.zIndex = String(1000 - sticker.trackIndex);
    const rotation = element.querySelector<HTMLElement>('.packaging-sticker-rotation');
    if (rotation) rotation.style.transform = `rotate(${sticker.rotationDeg}deg)`;
    element.dataset.stickerEdited = sticker.origin.kind === 'manual' || sticker.origin.positionPinned ? '1' : '';
  });
  win.__packagingAutoLayoutReplay?.apply();
  win.__packagingStickerEditBridge?.sync?.();
}

export function usePackagingPreviewGeometry(frameRef: RefObject<HTMLIFrameElement | null>, config: FinalEditPackagingConfig | undefined,
  structureKey: string, busy: boolean, mounted = true): string {
  // 结构变化等新结果完成后再切文档；只有几何变化时资源标识不变。
  const ready = config?.layoutRuntimeBundleVersion !== 2 || config.layoutResolution?.status === 'resolved';
  const nextKey = `${structureKey}|${config?.layoutResolution?.geometryManifestHash ?? ''}`;
  const [documentKey, setDocumentKey] = useState(() => ready ? nextKey : 'layout-waiting');
  const placeholderRetryRef = useRef('');
  if (ready && nextKey !== documentKey) setDocumentKey(nextKey);
  const geometryJson = JSON.stringify(config);
  useEffect(() => {
    if (busy || !mounted || !geometryJson) return;
    const frame = frameRef.current;
    if (!frame) return;
    const saved = JSON.parse(geometryJson) as FinalEditPackagingConfig;
    if (saved.layoutResolution?.status !== 'resolved') placeholderRetryRef.current = '';
    const apply = () => {
      // 请求跨过 stale 窗口时可能拿到占位页；只补载占位文档，绝不刷新已可编辑的文档。
      if (saved.layoutResolution?.status === 'resolved' && frame.contentDocument?.querySelector('[data-packaging-layout-pending]')) {
        const retryKey = `${documentKey}:${saved.layoutResolution.inputHash}`;
        if (placeholderRetryRef.current !== retryKey) {
          placeholderRetryRef.current = retryKey;
          frame.contentWindow?.location.reload();
        }
        return;
      }
      if ((frame.contentWindow as PreviewWindow | null)?.__pointLayout) placeholderRetryRef.current = '';
      syncPackagingPreviewGeometry(frame, saved);
    };
    apply();
    frame.addEventListener('load', apply);
    return () => frame.removeEventListener('load', apply);
  }, [frameRef, geometryJson, busy, documentKey, mounted]);
  return documentKey;
}
