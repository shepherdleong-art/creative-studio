'use client';

import { useEffect, useState } from 'react';
import PackagingOverlay, { type PackagingTextEditTarget } from '@/components/packaging/PackagingOverlay';
import { PackagingTextEditPopover } from '@/components/packaging/PackagingTextEditor';
import type { FinalEditPackagingConfig, PackagingVars } from '@/lib/media-core/packaging-vars';
import { FINAL_EDIT_INTRO_DURATION_US } from '@/lib/media-core/render-contract';

/** 只请求草稿预览；文字和版式写回抽屉草稿，应用前不保存成片配置。 */
export default function BatchCoverPackagingPreview({ url, config, assetId, editable, onChange }: {
  url: string; config: FinalEditPackagingConfig; assetId: string | null; editable: boolean;
  onChange: (config: FinalEditPackagingConfig) => void;
}) {
  const requestKey = JSON.stringify({ config, assetId });
  const [preview, setPreview] = useState<{ key: string; html: string; vars: PackagingVars } | null>(null);
  const [error, setError] = useState('');
  const [textEdit, setTextEdit] = useState<PackagingTextEditTarget | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestKey, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '包装预览加载失败');
        if (!controller.signal.aborted) { setPreview({ key: requestKey, html: data.html, vars: data.vars }); setError(''); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '包装预览加载失败');
      }
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [url, requestKey]);
  const ready = preview?.key === requestKey;
  return <>
    {preview && <PackagingOverlay srcDoc={preview.html} timeSec={FINAL_EDIT_INTRO_DURATION_US / 2e6} editable={editable && ready}
      onLayout={(id, layout) => {
        if (!id.startsWith('cover:')) return;
        const next = structuredClone(config);
        next.layouts ??= {};
        const template = next.layouts[next.template] ??= {};
        const cover = template.cover ??= {};
        if (layout) cover[id.slice(6)] = layout; else delete cover[id.slice(6)];
        onChange(next);
      }} onText={target => { if (target.pointId.startsWith('cover:')) setTextEdit(target); }} />}
    {textEdit && preview && <PackagingTextEditPopover key={textEdit.pointId} textEdit={textEdit}
      initialText={preview.vars[textEdit.pointId.slice(6) as keyof PackagingVars] ?? ''}
      onCancel={() => setTextEdit(null)} onCommit={value => {
        onChange({ ...config, varsOverrides: { ...config.varsOverrides, [textEdit.pointId.slice(6)]: value.trim() } });
        setTextEdit(null);
      }} />}
    {(error || !ready) && <p role={error ? 'alert' : 'status'} className="pointer-events-none absolute inset-x-0 bottom-0 bg-surface/90 p-2 text-center text-xs text-ink">{error || '正在更新包装预览…'}</p>}
  </>;
}
