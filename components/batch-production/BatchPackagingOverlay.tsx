'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/batch-production/output-arrangement';
import type { FinalEditPackagingConfig, PackagingVars } from '@/lib/media-core/packaging-vars';
import {
  applyPackagingStickerEdit,
  type PackagingStickerEditPatch,
  type PackagingStickerInstance,
} from '@/lib/media-core/packaging-stickers';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import PackagingOverlay, { type PackagingTextEditTarget } from '@/components/packaging/PackagingOverlay';
import { PackagingTextEditPopover } from '@/components/packaging/PackagingTextEditor';

const INTRO_SEC = FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS;

export type BatchStickerPlaybackRequest = {
  requestId: number;
  planId: string;
  stickerId: string;
};

export default function BatchPackagingOverlay({
  view,
  src,
  timeSec,
  editable,
  onSave,
  selectedStickerId = '',
  snapEnabled = true,
  onStickerSelect,
  onStickerDelete,
  onStickerExit,
  playbackRequest = null,
  onSeek,
}: {
  view: BatchOutputClipEditView;
  src: string;
  timeSec: number;
  editable: boolean;
  onSave?: (planId: string, edit: Record<string, unknown>) => Promise<boolean>;
  selectedStickerId?: string;
  snapEnabled?: boolean;
  onStickerSelect?: (stickerId: string) => void;
  onStickerDelete?: (stickerId: string) => void;
  onStickerExit?: () => void;
  playbackRequest?: BatchStickerPlaybackRequest | null;
  onSeek?: (bodySec: number) => void;
}) {
  const [textEdit, setTextEdit] = useState<PackagingTextEditTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const config = view.packaging;
  const stickers = config?.stickers ?? [];
  const selectedSticker = stickers.find((sticker) => sticker.id === selectedStickerId) ?? null;
  const timelineFrame = Math.floor(timeSec * FINAL_EDIT_FPS + 1e-6);
  const stickerEditId = config?.enabled && editable && view.editable && !busy && selectedSticker
    && timelineFrame >= selectedSticker.startFrame && timelineFrame < selectedSticker.endFrame
    ? selectedSticker.id : '';
  const playbackSticker = playbackRequest?.planId === view.planId
    ? stickers.find((sticker) => sticker.id === playbackRequest.stickerId) ?? null
    : null;
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => { frameRef.current = frame; }, []);

  useEffect(() => {
    if (!playbackRequest || !playbackSticker || !onSeek) return;
    let cancelled = false;
    let raf = 0;
    let playTimer = 0;
    const expectedAnimation = playbackSticker.animation;
    const deadline = Date.now() + 4_000;
    const attempt = () => {
      if (cancelled) return;
      try {
        const previewWindow = frameRef.current?.contentWindow as (Window & {
          compositionVariables?: { stickers?: PackagingStickerInstance[] };
          __hyperframes?: { getVariables?: () => { stickers?: PackagingStickerInstance[] } };
          __timelines?: { overlay?: unknown };
        }) | null;
        const vars = previewWindow?.compositionVariables ?? previewWindow?.__hyperframes?.getVariables?.();
        const runtimeSticker = vars?.stickers?.find((sticker) => sticker.id === playbackSticker.id);
        const ready = previewWindow?.document.readyState === 'complete'
          && runtimeSticker?.animation === expectedAnimation
          && Boolean(previewWindow.__timelines?.overlay);
        if (ready) {
          onSeek(playbackSticker.startFrame / FINAL_EDIT_FPS - INTRO_SEC);
          playTimer = window.setTimeout(() => {
            if (cancelled) return;
            document.querySelector<HTMLButtonElement>('[data-toggle-play][aria-label="播放"]')?.click();
          }, 60);
          return;
        }
      } catch { /* iframe 替换期间继续等待新文档 */ }
      if (Date.now() < deadline) raf = window.requestAnimationFrame(attempt);
    };
    raf = window.requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      if (playTimer) window.clearTimeout(playTimer);
    };
  }, [onSeek, playbackRequest, playbackSticker]);

  if (!config) return null;
  const save = async (next: FinalEditPackagingConfig) => {
    if (saving.current || !onSave || !view.editable) return false;
    saving.current = true; setBusy(true); setError('');
    try {
      const accepted = await onSave(view.planId, { type: 'set_packaging', config: next, expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId });
      if (!accepted) setError('包装修改未保存，请重试');
      return accepted;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '包装修改失败');
      return false;
    } finally {
      saving.current = false; setBusy(false);
    }
  };
  const commitSticker = (stickerId: string, patch: PackagingStickerEditPatch) => {
    const next = structuredClone(config);
    next.stickers = (next.stickers ?? []).map((sticker) => sticker.id === stickerId ? applyPackagingStickerEdit(sticker, patch) : sticker);
    void save(next);
  };
  return <>
    <PackagingOverlay
      src={src}
      timeSec={timeSec}
      editable={editable && view.editable && !busy}
      stickerEditId={stickerEditId}
      stickerSnapEnabled={snapEnabled}
      onFrame={attachFrame}
      onStickerSelect={(stickerId) => { setTextEdit(null); onStickerSelect?.(stickerId); }}
      onStickerCommit={commitSticker}
      onStickerDelete={onStickerDelete}
      onStickerExit={onStickerExit}
      onText={(target) => { onStickerExit?.(); setTextEdit(target); }}
      onLayout={(id, value) => {
        const next = structuredClone(config);
        next.layouts ??= {};
        const template = next.layouts[next.template] ??= {};
        const entries = template[id.startsWith('cover:') ? 'cover' : 'cues'] ??= {};
        const key = id.slice(id.indexOf(':') + 1);
        if (value) entries[key] = value; else delete entries[key];
        void save(next);
      }}
    />
    {textEdit && <PackagingTextEditPopover key={textEdit.pointId} textEdit={textEdit}
      initialText={textEdit.pointId.startsWith('cover:') ? config.varsOverrides[textEdit.pointId.slice(6) as keyof PackagingVars] ?? '' : config.pointCues?.find(cue => `cue:${cue.id}` === textEdit.pointId)?.text ?? ''}
      onCancel={() => setTextEdit(null)} onCommit={value => {
        const next = structuredClone(config);
        const id = textEdit.pointId;
        setTextEdit(null);
        if (id.startsWith('cover:')) next.varsOverrides[id.slice(6) as keyof PackagingVars] = value.trim();
        else {
          if (!value.trim()) { setError('正片卖点文字不能为空，请在时间轴删除该卖点'); return; }
          next.pointCuesEdited = true;
          next.pointCues = next.pointCues?.map(cue => `cue:${cue.id}` === id ? { ...cue, text: value.trim() } : cue);
        }
        void save(next);
      }} />}
    {error && <p role="alert" className="absolute inset-x-0 bottom-0 bg-surface p-2 text-xs text-fail">{error}</p>}
  </>;
}
