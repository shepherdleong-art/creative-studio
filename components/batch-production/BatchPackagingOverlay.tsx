'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/batch-production/output-arrangement';
import type { FinalEditPackagingConfig, PackagingLayouts, PackagingPointLayout, PackagingVars } from '@/lib/media-core/packaging-vars';
import PackagingOverlay, { type PackagingTextEditTarget } from '@/components/packaging/PackagingOverlay';
import { PackagingTextEditPopover } from '@/components/packaging/PackagingTextEditor';

export default function BatchPackagingOverlay({ view, src, timeSec, editable, onSave }: {
  view: BatchOutputClipEditView; src: string; timeSec: number; editable: boolean;
  onSave?: (planId: string, edit: Record<string, unknown>) => Promise<boolean>;
}) {
  const [textEdit, setTextEdit] = useState<PackagingTextEditTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => { frameRef.current = frame; }, []);
  const config = view.packaging;
  // 版式由模板的实时编辑桥更新；保存修订不能销毁 iframe，否则每次松手都会闪屏。
  // 文案、字体、模板、时序及封面取色/默认文案来源变化仍须重新生成包装文档。
  const previewKey = JSON.stringify([
    src, view.outputVersionId, { ...config, layouts: undefined },
    view.coverAssetId ?? view.clips[0]?.assetId, view.coverTitleOverride ? view.coverTitle : null,
    view.subtitleCues, Math.max(view.visualDurationUs, view.narration.durationUs ?? 0),
  ]);
  const layoutsKey = JSON.stringify(config?.layouts?.[config.template] ?? {});
  const syncLayouts = useCallback(() => {
    const win = frameRef.current?.contentWindow as (Window & {
      __pointLayout?: { apply: (element: HTMLElement, layout: PackagingPointLayout | null) => void };
    }) | null;
    if (!win?.__pointLayout) return;
    const layouts = JSON.parse(layoutsKey) as PackagingLayouts[string];
    win.document.querySelectorAll<HTMLElement>('[data-point-id]').forEach((element) => {
      const id = element.dataset.pointId ?? '';
      const layout = id.startsWith('cover:') ? layouts?.cover?.[id.slice(6)] : layouts?.cues?.[id.slice(4)];
      // 默认元素保持模板自动适配；被手改的元素则允许撤销、复位或保存失败回滚。
      if (layout || element.dataset.ul === '1') win.__pointLayout!.apply(element, layout ?? null);
    });
  }, [layoutsKey]);
  useEffect(() => {
    if (busy) return;
    const frame = frameRef.current;
    syncLayouts();
    frame?.addEventListener('load', syncLayouts);
    return () => frame?.removeEventListener('load', syncLayouts);
  }, [busy, previewKey, syncLayouts]);
  if (!config) return null;
  const save = async (next: FinalEditPackagingConfig) => {
    if (saving.current || !onSave || !view.editable) return;
    saving.current = true; setBusy(true); setError('');
    try {
      if (!await onSave(view.planId, { type: 'set_packaging', config: next, expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId })) setError('包装修改未保存，请重试');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '包装修改失败'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <>
    <PackagingOverlay key={previewKey} onFrame={attachFrame} src={src} timeSec={timeSec} editable={editable && view.editable && !busy} onText={setTextEdit} onLayout={(id, value) => {
      const next = structuredClone(config);
      next.layouts ??= {};
      const template = next.layouts[next.template] ??= {};
      const entries = template[id.startsWith('cover:') ? 'cover' : 'cues'] ??= {};
      const key = id.slice(id.indexOf(':') + 1);
      if (value) entries[key] = value; else delete entries[key];
      void save(next);
    }} />
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
