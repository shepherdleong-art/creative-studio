'use client';

import { useEffect, useState } from 'react';
import type { FormulaPreviewView } from '@/lib/batch-production/formula/preview';
import type { OutputPresetId } from '@/lib/media-core/cover-types';
import BatchTimelinePreview from '../BatchTimelinePreview';

/** 在原审片预览区消费已保存排片；后续可编辑版本仍由统一时间轴承接。 */
export default function FormulaOutputPreview({ projectId, batchId, planId, outputPreset, playheadSec, onSeek }: {
  projectId: string; batchId: string; planId: string; outputPreset: OutputPresetId;
  playheadSec: number; onSeek: (seconds: number) => void;
}) {
  const [view, setView] = useState<FormulaPreviewView | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(`/api/batch-production/batches/${encodeURIComponent(batchId)}/formula/outputs/${encodeURIComponent(planId)}/preview?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store', signal: controller.signal });
        const next = await response.json();
        if (!response.ok) throw new Error(next.message || '预览读取失败');
        if (controller.signal.aborted) return;
        setView(next); setError('');
        if (next.status === 'pending') timer = setTimeout(load, 2_000);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '预览读取失败');
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, batchId, planId, retry]);
  if (error) return <div className="space-y-2 p-3 text-xs"><p role="alert" className="text-fail">{error}</p>
    <button type="button" className="btn-secondary" onClick={() => setRetry(value => value + 1)}>重新读取预览</button></div>;
  const preview = view?.preview;
  if (!preview) return <div className="space-y-2 p-3 text-xs text-ink-secondary">
    <p role="status">{view?.message ?? '正在读取排片预览…'}</p>
    {view?.status === 'needs_attention' && <button type="button" className="btn-secondary" onClick={() => setRetry(value => value + 1)}>重新读取预览</button>}
  </div>;
  return <div className="flex h-full min-h-0 w-full flex-col gap-1">
    <p className="shrink-0 bg-surface px-2 py-1 text-xs text-ink-secondary">{view.message}</p>
    <div className="min-h-0 flex-1">
      <BatchTimelinePreview key={preview.timelineStageId} clips={preview.clips} audioTimeline={preview.audioTimeline}
        assetsById={preview.assetsById} coverUrl={null} subtitleCues={preview.subtitleCues}
        narrationUrl={null} narrationGainDb={0} bgm={null} outputPreset={outputPreset}
        playheadSec={playheadSec} onSeek={onSeek} active compact />
    </div>
  </div>;
}
