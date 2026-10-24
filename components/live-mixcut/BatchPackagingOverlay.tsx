'use client';

import { useRef, useState } from 'react';
import type { BatchOutputClipEditView } from '@/lib/live-mixcut/output-arrangement';
import type { FinalEditPackagingConfig, PackagingVars } from '@/lib/media-core/packaging-vars';
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
  const config = view.packaging;
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
    <PackagingOverlay src={src} timeSec={timeSec} editable={editable && view.editable && !busy} onText={setTextEdit} onLayout={(id, value) => {
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
