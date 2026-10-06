'use client';
import { useEffect, useState } from 'react';
import type { CanvasDraftSource, CanvasVideoMetadata } from '@/lib/creative-canvas/video-metadata';
import type { CanvasGenerationMode } from '@/lib/creative-canvas/types';
import type { CanvasEditorController } from './editor-store';

/** An asset ID selects an immutable result; rerunning its producer cannot replace this selection. */
export function DraftActions({ assetId, controller, position, bound = false }: {
  assetId: string | null; controller: CanvasEditorController; position: { x: number; y: number }; bound?: boolean;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const [state, setState] = useState<{ assetId: string; source: CanvasDraftSource | null; metadata?: CanvasVideoMetadata; reason?: string } | null>(null);
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
  const tailAction = tailAssetId ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async () => { const id = await controller.addNode('material', position); if (id) controller.updateNodeData(id, { title: '返回尾帧', assetId: tailAssetId, mediaKind: 'image' }); }}>添加返回尾帧素材</button> : null;
  if (!source && state?.assetId === assetId && state.metadata?.stage === 'draft') return <div className="mt-2 text-[11px] text-ink-secondary">{tailAction}{state.reason ?? '供应商尚未确认可转正式的样片身份'}</div>;
  if (!source && tailAction && !bound) return tailAction;
  if (!source) return bound ? <div className="mt-2 text-[11px] text-ink-secondary">{state?.assetId === assetId ? state.reason ?? '样片来源不可用，请重新选片' : '正在核对固定样片…'}</div> : null;
  const expired = source.expired || Date.parse(source.expiresAt) <= clock;
  return <div className="mt-2 text-[11px] text-ink-secondary" data-testid="draft-source">
    {tailAction}
    <div>{bound ? '固定样片' : '样片'} · {source.taskId.slice(0, 8)} · {expired ? '已过期，可下载原片' : `有效至 ${new Date(source.expiresAt).toLocaleString('zh-CN')}`}</div>
    {bound ? <div>直连方舟 · Seedance 2.5 · 时长 {source.parameters.durationSec === -1 ? '自动' : `${source.parameters.durationSec ?? 5} 秒`} · 比例 {String(source.parameters.aspectRatio ?? '跟随素材')} · 声音 {(source.parameters.withAudio ?? true) ? '开启' : '关闭'}。仅单点运行会生成正式视频。</div> : null}
    {!bound && !expired ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async () => {
      const id = await controller.addNode('video-generation', position);
      if (id) controller.updateNodeData(id, {
        title: '样片转正式', modelKey: 'external-jimeng-seedance-2-5',
        generationMode: source.generationMode as CanvasGenerationMode, prompt: '', references: [],
        parameters: { generationStage: 'final-from-draft', draftAssetId: source.assetId, resolution: '1080p', outputFormat: 'mp4', watermark: false, returnLastFrame: false },
      });
    }}>基于此样片生成正式视频</button> : null}
    {expired ? <button type="button" className="nodrag sc-canvas-button mt-1" onClick={async () => {
      const id = await controller.addNode('video-generation', position);
      if (id) controller.updateNodeData(id, { title: '重新生成样片', prompt: source.prompt, modelKey: 'external-jimeng-seedance-2-5', generationMode: source.generationMode as CanvasGenerationMode,
        parameters: { ...source.parameters, generationStage: 'draft', resolution: '480p' } });
    }}>新建样片节点（重新连接素材）</button> : null}
  </div>;
}
