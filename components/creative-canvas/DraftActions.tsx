'use client';

import { useEffect, useRef, useState } from 'react';
import type { CanvasDraftSource, CanvasVideoMetadata, CanvasVideoResultInfo } from '@/lib/creative-canvas/video-metadata';
import type { CanvasGenerationMode } from '@/lib/creative-canvas/types';
import type { CanvasEditorController } from './editor-store';
import { useNodeRuntime } from './runtime-store';

const resultTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hour12: false });

/** Show the original result's metadata and any actions available for that asset. */
export function DraftActions({ nodeId, assetId, controller, position }: {
  nodeId: string; assetId: string | null; controller: CanvasEditorController; position: { x: number; y: number };
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [state, setState] = useState<{
    assetId: string; source: CanvasDraftSource | null; metadata?: CanvasVideoMetadata; result?: CanvasVideoResultInfo | null; reason?: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const requestKey = useRef<string | null>(null);
  const runtime = useNodeRuntime(controller.runtime, nodeId);
  const active = Boolean(runtime?.activeTasks.length);
  useEffect(() => {
    if (!assetId) return;
    const abort = new AbortController();
    fetch(`/api/canvas/assets/${encodeURIComponent(assetId)}/draft`, { signal: abort.signal })
      .then((response) => response.json()).then((value) => setState({ assetId, ...value }))
      .catch(() => { if (!abort.signal.aborted) setState({ assetId, source: null, reason: '无法读取样片来源' }); });
    return () => abort.abort();
  }, [assetId]);
  const current = state?.assetId === assetId ? state : null;
  const source = current?.source;
  const tailAssetId = current?.metadata?.tailAssetId;
  const result = current?.result;
  const resultLabel = result ? (
    <div className="mt-2 grid gap-0.5 text-label text-ink-secondary" data-testid="canvas-video-result-info">
      <span className="min-w-0 truncate font-medium text-ink" title={result.model}>模型 · {result.modelName}</span>
      <time className="tnum" dateTime={result.completedAt}>生成于 {resultTimeFormat.format(new Date(result.completedAt))}</time>
    </div>
  ) : null;
  const tailAction = tailAssetId ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async (event) => {
    event.currentTarget.blur();
    const id = await controller.addNode('material', position);
    if (id) controller.updateNodeData(id, { title: '返回尾帧', assetId: tailAssetId, mediaKind: 'image' });
  }}>添加返回尾帧素材</button> : null;
  if (!source) return <>
    {resultLabel}
    {tailAction}
    {current?.metadata?.stage === 'draft' ? <div className="mt-2 text-label text-ink-secondary">{current.reason ?? '供应商尚未确认可转正式的样片身份'}</div> : null}
  </>;
  const expired = source.expired || Date.parse(source.expiresAt) <= clock;
  return <>{resultLabel}<div className="mt-2 text-[11px] text-ink-secondary" data-testid="draft-source">
    {tailAction}
    <div>样片 · {source.taskId.slice(0, 8)} · {expired ? '已过期，可下载原片' : `有效至 ${new Date(source.expiresAt).toLocaleString('zh-CN')}`}</div>
    {!expired ? <button type="button" className="nodrag sc-canvas-button mt-1" disabled={submitting || active} onClick={async (event) => {
      event.currentTarget.blur();
      if (pending.current || active) return;
      pending.current = true;
      setSubmitting(true);
      requestKey.current ??= `draft-final-${crypto.randomUUID()}`;
      try {
        if (await controller.runDraftFinal(nodeId, source.assetId, requestKey.current)) requestKey.current = null;
      } finally {
        pending.current = false;
        setSubmitting(false);
      }
    }}>{submitting ? '提交中…' : active ? '正式版生成中…' : '生成正式版'}</button> : null}
    {expired ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async (event) => {
      event.currentTarget.blur();
      const id = await controller.addNode('video-generation', position);
      if (id) controller.updateNodeData(id, {
        title: '重新生成样片', prompt: source.prompt, modelKey: source.capabilityKey || 'external-jimeng-seedance-2-5',
        generationMode: source.generationMode as CanvasGenerationMode,
        parameters: { ...source.parameters, generationStage: 'draft', resolution: '480p' },
      });
    }}>新建样片节点（重新连接素材）</button> : null}
  </div></>;
}
