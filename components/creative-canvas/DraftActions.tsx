'use client';

import { useEffect, useRef, useState } from 'react';
import type { CanvasDraftSource, CanvasVideoMetadata } from '@/lib/creative-canvas/video-metadata';
import type { CanvasGenerationMode } from '@/lib/creative-canvas/types';
import type { CanvasEditorController } from './editor-store';
import { useNodeRuntime } from './runtime-store';

/** Draft actions belong to the immutable video result, never its generator. */
export function DraftActions({ nodeId, assetId, controller, position }: {
  nodeId: string; assetId: string | null; controller: CanvasEditorController; position: { x: number; y: number };
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [state, setState] = useState<{ assetId: string; source: CanvasDraftSource | null; metadata?: CanvasVideoMetadata; reason?: string } | null>(null);
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
  const source = state?.assetId === assetId ? state.source : null;
  const tailAssetId = state?.assetId === assetId ? state.metadata?.tailAssetId : undefined;
  const tailAction = tailAssetId ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async (event) => {
    event.currentTarget.blur();
    const id = await controller.addNode('material', position);
    if (id) controller.updateNodeData(id, { title: '返回尾帧', assetId: tailAssetId, mediaKind: 'image' });
  }}>添加返回尾帧素材</button> : null;
  if (!source && state?.assetId === assetId && state.metadata?.stage === 'draft') return <div className="mt-2 text-[11px] text-ink-secondary">{tailAction}{state.reason ?? '供应商尚未确认可转正式的样片身份'}</div>;
  if (!source) return tailAction;
  const expired = source.expired || Date.parse(source.expiresAt) <= clock;
  return <div className="mt-2 text-[11px] text-ink-secondary" data-testid="draft-source">
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
  </div>;
}
