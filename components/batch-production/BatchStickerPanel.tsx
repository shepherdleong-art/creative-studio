'use client';

import { useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/batch-production/output-arrangement';
import type { FinalEditPackagingConfig } from '@/lib/media-core/packaging-vars';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import {
  DEFAULT_PACKAGING_STICKER_DEFAULTS,
  MAX_STICKER_INSTANCES,
  STICKER_AUTO_MIN_BODY_FRAMES,
  applyPackagingStickerEdit,
  planStickerFramesAtPlayhead,
  type PackagingStickerEditPatch,
  type PackagingStickerInstance,
  type StickerAnimation,
} from '@/lib/media-core/packaging-stickers';
import { normalizePackagingStickerTracks } from '@/lib/media-core/packaging-sticker-timeline';
import { planPackagingStickerAutoLayout, replaceAutomaticPackagingStickers } from '@/lib/media-core/packaging-sticker-planner';
import { StickerPanel, type StickerAssetChoice, type StickerCatalogAsset } from '@/components/mixcut/StickerPanel';

const INTRO_SEC = FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS;

export type BatchStickerPanelView = Pick<BatchOutputClipEditView, 'packaging' | 'editable'>
  & Partial<Pick<BatchOutputClipEditView, 'visualDurationUs' | 'narration'>>;

export default function BatchStickerPanel({
  active,
  view,
  playheadSec,
  selectedStickerId,
  onSave,
  onAdd,
  onDragStart,
  onDragEnd,
  onPlaySticker,
}: {
  active: boolean;
  view: BatchStickerPanelView;
  playheadSec: number;
  selectedStickerId: string;
  onSave: (config: FinalEditPackagingConfig) => Promise<boolean>;
  onAdd: (choice: StickerAssetChoice) => void;
  onDragStart: (choice: StickerAssetChoice) => void;
  onDragEnd: () => void;
  onPlaySticker: (stickerId: string) => void;
}) {
  const config = view.packaging!;
  const stickers = config.stickers ?? [];
  const selectedSticker = stickers.find((sticker) => sticker.id === selectedStickerId) ?? null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const saving = useRef(false);
  const bodyFrames = Math.floor(Math.max(view.visualDurationUs ?? 0, view.narration?.durationUs ?? 0) / 1e6 * FINAL_EDIT_FPS + 1e-6);
  const placement = planStickerFramesAtPlayhead(playheadSec + INTRO_SEC, bodyFrames);
  const addBlockedReason = !config.enabled
    ? '开启视频包装后可添加与编辑贴纸；已有贴纸数据会继续保留。'
    : stickers.length >= MAX_STICKER_INSTANCES
      ? `单个视频最多放置 ${MAX_STICKER_INSTANCES} 张贴纸。`
      : !placement
        ? bodyFrames < 19 ? '正文不足 19 帧，无法添加贴纸。' : '当前位置剩余正文不足 19 帧，请将播放头前移后再添加。'
        : '';
  const autoLayoutBlockedReason = bodyFrames < STICKER_AUTO_MIN_BODY_FRAMES
    ? '正文不足 6 秒，无法一键布置；请手动添加贴纸。'
    : stickers.filter((sticker) => sticker.origin.kind !== 'auto').length + 6 > MAX_STICKER_INSTANCES
      ? `手动贴纸过多，自动布置后不能超过 ${MAX_STICKER_INSTANCES} 张。`
      : '';

  const save = async (next: FinalEditPackagingConfig): Promise<boolean> => {
    if (saving.current || !view.editable) return false;
    saving.current = true;
    setBusy(true);
    setMessage('');
    try {
      const accepted = await onSave(next);
      if (!accepted) setMessage('保存未成功，请刷新当前成片后重试');
      return accepted;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const applyStickerInstances = (update: (current: PackagingStickerInstance[]) => PackagingStickerInstance[]) => {
    const next = structuredClone(config);
    next.stickers = normalizePackagingStickerTracks(update(stickers));
    return save(next);
  };

  const applyStickerPatch = (stickerId: string, patch: PackagingStickerEditPatch) => {
    const normalized = { ...patch };
    if (normalized.centerXPct !== undefined) normalized.centerXPct = Math.min(100, Math.max(0, normalized.centerXPct));
    if (normalized.centerYPct !== undefined) normalized.centerYPct = Math.min(100, Math.max(0, normalized.centerYPct));
    if (normalized.visualWidthPct !== undefined) normalized.visualWidthPct = Math.min(1000, Math.max(1, normalized.visualWidthPct));
    if (normalized.rotationDeg !== undefined) normalized.rotationDeg = Math.min(180, Math.max(-180, normalized.rotationDeg));
    return applyStickerInstances((current) => current.map((sticker) => sticker.id === stickerId ? applyPackagingStickerEdit(sticker, normalized) : sticker));
  };

  const handleDefaultAnimationChange = (animation: StickerAnimation) => {
    if (busy || !config.enabled) return;
    void save({ ...structuredClone(config), stickerDefaults: { animation } });
  };

  const handleApplyAnimationToAll = (animation: StickerAnimation) => {
    if (busy || !config.enabled || stickers.length === 0) return;
    if (stickers.some((sticker) => sticker.animation !== animation)
      && !window.confirm('部分贴纸使用了单独动效，应用后将重置这些覆盖。是否继续？')) return;
    void applyStickerInstances((current) => current.map((sticker) => applyPackagingStickerEdit(sticker, { animation }))).then((accepted) => {
      if (!accepted) return;
      const targetId = selectedStickerId || stickers[0]?.id;
      if (targetId) onPlaySticker(targetId);
    });
  };

  const handleAutoLayout = (assets: StickerCatalogAsset[]) => {
    if (busy || !config.enabled) return;
    if (autoLayoutBlockedReason) {
      setMessage(autoLayoutBlockedReason);
      return;
    }
    const automatic = stickers.filter((sticker) => sticker.origin.kind === 'auto');
    if (automatic.some((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoEdited)
      && !window.confirm('当前自动组合中有已编辑贴纸，换一组将重置这些调整。是否继续？')) return;
    let generated: PackagingStickerInstance[] | null = null;
    try {
      generated = planPackagingStickerAutoLayout({
        bodyFrames,
        template: config.template,
        assets,
        animation: (config.stickerDefaults ?? DEFAULT_PACKAGING_STICKER_DEFAULTS).animation,
        autoGroupId: `auto_${crypto.randomUUID()}`,
        random: Math.random,
        createId: () => `s_${crypto.randomUUID()}`,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!generated) {
      setMessage('正文不足 6 秒，无法一键布置；请手动添加贴纸。');
      return;
    }
    void applyStickerInstances((current) => replaceAutomaticPackagingStickers(current, generated)).then((accepted) => {
      if (accepted) setMessage(automatic.length > 0 ? '已换一组基础贴纸，手动贴纸已保留' : '已生成 6 张基础贴纸');
    });
  };

  return <>
    <StickerPanel
      active={active}
      enabled={config.enabled}
      busy={busy || !view.editable}
      template={config.template}
      stickers={stickers}
      selectedSticker={selectedSticker}
      defaultAnimation={(config.stickerDefaults ?? DEFAULT_PACKAGING_STICKER_DEFAULTS).animation}
      addBlockedReason={addBlockedReason}
      autoLayoutBlockedReason={autoLayoutBlockedReason}
      onAdd={onAdd}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPatchSticker={applyStickerPatch}
      onDefaultAnimationChange={handleDefaultAnimationChange}
      onApplyAnimationToAll={handleApplyAnimationToAll}
      onPlaySticker={onPlaySticker}
      onAutoLayout={handleAutoLayout}
    />
    {message && <p role="status" className="text-xs text-ink-secondary">{message}</p>}
  </>;
}
