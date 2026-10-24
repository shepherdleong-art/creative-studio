'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchOutputClipEditView, BatchOutputPoolAssetView } from '@/lib/live-mixcut/output-arrangement';
import { FINAL_EDIT_FPS as FPS } from '@/lib/media-core/render-contract';
import { TrimEditor } from '@/components/mixcut/TrimEditor';
import { LutVideoPlayer } from '../LutVideoPlayer';

export interface SourceMonitorSession {
  view: BatchOutputClipEditView;
  clipId: string;
  asset: BatchOutputPoolAssetView;
}

export default function BatchSourceMonitor({ session, projectId, onApply, onClose }: {
  session: SourceMonitorSession; projectId: string;
  onApply: (planId: string, edit: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const { view, asset, clipId } = session;
  const clipIndex = view.clips.findIndex(item => item.clipId === clipId);
  const clip = view.clips[clipIndex];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(asset.durationSec ?? 0);
  const [error, setError] = useState('');
  const pendingSeekRef = useRef<number | null>(clip.sourceStartUs / 1e6);
  const flushSeek = useCallback(() => {
    const video = videoRef.current;
    const target = pendingSeekRef.current;
    if (!video || target === null || video.readyState === 0 || video.seeking) return;
    pendingSeekRef.current = null;
    if (Math.abs(video.currentTime - target) > 1e-6) video.currentTime = target;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    // 先让正在解码的帧上屏，再追上最新入点；连续拖动不反复取消在途 seek。
    let frame = 0;
    const onSeeked = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(flushSeek); };
    video?.addEventListener('seeked', onSeeked);
    return () => {
      cancelAnimationFrame(frame);
      video?.removeEventListener('seeked', onSeeked);
    };
  }, [flushSeek]);
  const seek = (sec: number) => {
    pendingSeekRef.current = sec;
    videoRef.current?.pause();
    flushSeek();
  };

  return <div className="flex h-full min-h-0 w-full flex-col gap-1" data-source-monitor>
    <div className="min-h-0 flex-1">
      <LutVideoPlayer src={`/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`}
        videoRef={videoRef} ariaLabel={`完整素材：${asset.displayName}`} className="h-full w-full" poster={asset.thumbnailUrl}
        lut={asset.lutId ? { lutId: asset.lutId, url: `/api/live-mixcut/luts/${encodeURIComponent(asset.lutId)}/file?projectId=${encodeURIComponent(projectId)}` } : null}
        onLoadedMetadata={event => { setDuration(event.currentTarget.duration); flushSeek(); }}
        onError={() => setError('源视频加载失败，请检查素材是否可用')} />
    </div>
    <TrimEditor compact clip={{ sourceInFrame: clip.sourceStartUs * FPS / 1e6, sourceOutFrame: clip.sourceEndUs * FPS / 1e6 }}
      clipIndex={clipIndex} asset={{ durationUs: Math.round(duration * 1e6), thumbnailUrl: asset.thumbnailUrl }}
      disabled={!view.editable || !(duration > 0)} onPreview={seek} onClose={onClose}
      onCommit={async startFrame => {
        videoRef.current?.pause(); setError('');
        // 保留源片段的精确微秒长度以及时间轴位置/速度，复用既有等长 trim 命令。
        const sourceStartUs = Math.round(startFrame / FPS * 1e6);
        if (sourceStartUs === clip.sourceStartUs) return true;
        try {
          const saved = await onApply(view.planId, { type: 'trim', clipId, sourceStartUs,
            sourceEndUs: sourceStartUs + clip.sourceEndUs - clip.sourceStartUs,
            expectedEditRevision: view.editRevision, expectedOutputVersionId: view.outputVersionId });
          if (!saved) setError('截取未保存，请重试；若成片已更新，请返回后重新打开素材。');
          return saved;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : '截取未保存，请重试');
          return false;
        }
      }} />
    {error && <p role="alert" className="shrink-0 px-2 text-xs text-fail">{error}</p>}
  </div>;
}
