'use client';

import BatchSourceMonitor, { type SourceMonitorSession } from './BatchSourceMonitor';
import FormulaManualMediaMonitor from './FormulaManualMediaMonitor';
import BatchPackagingOverlay from '../BatchPackagingOverlay';
import { useCallback, useMemo, useRef } from 'react';
import type { OutputPresetId } from '@/lib/final-edit/types';
import type { BatchOutputClipEditView, BatchOutputPoolAssetView } from '@/lib/live-mixcut/output-arrangement';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import BatchTimelinePreview, { type BatchTimelinePreviewClip } from '../BatchTimelinePreview';
import FormulaOutputPreview from '../formula/FormulaOutputPreview';
import { LutVideoPlayer } from '../LutVideoPlayer';
import { useProxyPlaybackPreference } from '../proxy-playback-preference';
import type { FormulaMediaSession, UnifiedFilmState } from './types';
import styles from './batch-unified-review.module.css';

const INTRO_SEC = FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS;

export interface BatchReviewPreviewDockProps {
  packagingEditable?: boolean;
  coverPreviewRequest?: number;
  sourceSession?: SourceMonitorSession | FormulaMediaSession | null;
  onSourceApply?: (planId: string, edit: Record<string, unknown>, undoBasis?: BatchOutputClipEditView) => Promise<boolean>;
  projectId: string;
  batchId: string;
  outputPreset: OutputPresetId;
  previewFilm: UnifiedFilmState | null;
  previewAsset: BatchOutputPoolAssetView | null;
  onClearPreviewAsset: () => void;
  playheadSec: number;
  onSeek: (sec: number) => void;
  onToggleReview?: (planId: string, currentApproved: boolean) => void;
  reviewBusy?: boolean;
  reviewError?: string | null;
  poolAssets: BatchOutputPoolAssetView[];
}

export default function BatchReviewPreviewDock({
  packagingEditable = false,
  coverPreviewRequest = 0,
  sourceSession,
  onSourceApply,
  projectId,
  batchId,
  outputPreset,
  previewFilm,
  previewAsset,
  onClearPreviewAsset,
  playheadSec,
  onSeek,
  onToggleReview,
  reviewBusy = false,
  reviewError,
  poolAssets,
}: BatchReviewPreviewDockProps) {
  const { proxyPlayback } = useProxyPlaybackPreference();
  const materialVideoRef = useRef<HTMLVideoElement | null>(null);
  // 主时间轴使用正文秒，复用播放器使用含封面的成片秒；只在这个边界换算。
  // 封面播放期间正文播放头停在 0，负值只用来保存封面内的播放位置。
  const handlePreviewSeek = useCallback((sec: number) => onSeek(sec - INTRO_SEC), [onSeek]);

  const poolAssetsById = useMemo(
    () => new Map(poolAssets.map((asset) => [asset.assetId, asset])),
    [poolAssets]
  );

  // Build assetsById map for BatchTimelinePreview
  const previewAssetsMap = useMemo(() => {
    const map: Record<string, { previewUrl: string; originalUrl?: string; lutId?: string | null; lutUrl?: string }> = {};
    for (const asset of poolAssets) {
      map[asset.assetId] = {
        previewUrl: asset.previewUrl
          ? asset.previewUrl
          : `/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`,
        originalUrl: `/api/live-mixcut/assets/${encodeURIComponent(asset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`,
        lutId: asset.lutId ?? null,
        lutUrl: asset.lutId
          ? `/api/live-mixcut/luts/${encodeURIComponent(asset.lutId)}/file?projectId=${encodeURIComponent(projectId)}`
          : undefined,
      };
    }
    return map;
  }, [poolAssets, projectId]);

  const arrangement = previewFilm?.arrangement;
  const clips: BatchTimelinePreviewClip[] = arrangement?.clips
    ? arrangement.clips.map((clip) => ({
        clipId: clip.clipId,
        assetId: clip.assetId,
        sourceStartUs: clip.sourceStartUs,
        sourceEndUs: clip.sourceEndUs,
        timelineStartUs: clip.timelineStartUs,
        timelineEndUs: clip.timelineEndUs,
        playbackRate: clip.playbackRate ?? 1,
        framing: clip.framing,
      }))
    : [];

  const coverUrl = (() => {
    if (!previewFilm?.coverAttemptId) return null;
    const params = new URLSearchParams({
      projectId,
      kind: 'cover',
      source: 'candidate',
      renderAttemptId: previewFilm.coverAttemptId,
    });
    return `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(previewFilm.planId)}/media?${params.toString()}`;
  })();

  const coverAsset = arrangement?.coverAssetId ? (poolAssetsById.get(arrangement.coverAssetId) ?? null) : null;

  const narrationUrl = previewFilm?.planId && arrangement?.narration?.audioRelativePath
    ? `/api/live-mixcut/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(previewFilm.planId)}/media?projectId=${encodeURIComponent(projectId)}&kind=narration&source=candidate`
    : null;

  const previewBgm = (() => {
    if (!arrangement?.music?.trackId) return null;
    if (arrangement.formulaPreview) {
      const music = arrangement.formulaPreview.music;
      return music ? { fileUrl: music.fileUrl, durationUs: music.durationUs, gainDb: arrangement.music.gainDb,
        fadeInSec: arrangement.music.fadeInSec, fadeOutSec: arrangement.music.fadeOutSec, ducking: arrangement.music.ducking } : null;
    }
    const track = arrangement.musicLibrary?.find((t) => t.id === arrangement.music?.trackId);
    if (!track) return null;
    return {
      fileUrl: `/api/final-edit-bgm/${encodeURIComponent(track.id)}/file`,
      gainDb: arrangement.music.gainDb,
      fadeInSec: arrangement.music.fadeInSec,
      fadeOutSec: arrangement.music.fadeOutSec,
    };
  })();

  const durationSec = previewFilm?.durationSec ?? 0;
  const isPastDuration = !previewAsset && previewFilm && playheadSec > durationSec;

  return (
    <section className={`${styles.dock} h-full`} aria-label="成片实时预览">
      <div className={styles.dockHead}>
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="truncate text-xs font-semibold text-ink">
            {previewAsset ? (
              `素材预览 · ${previewAsset.displayName}`
            ) : previewFilm ? (
              `视频预览 · ${String(previewFilm.seq).padStart(2, '0')} ${previewFilm.scriptTitle || '未命名脚本'}`
            ) : (
              '视频预览'
            )}
          </h3>
          {previewFilm && !previewAsset && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                previewFilm.approved
                  ? 'bg-ok/10 text-ok'
                  : previewFilm.approvable
                  ? 'bg-accent/10 text-accent'
                  : 'bg-warn/20 text-warn'
              }`}
            >
              {previewFilm.approved ? '已确认' : previewFilm.approvable ? '待检查' : previewFilm.executionTask?.status === 'failed' ? '需处理' : '处理中'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {previewAsset ? (
            <button
              type="button"
              className="btn-secondary flex h-7 items-center gap-1 px-2.5 text-xs text-accent"
              onClick={onClearPreviewAsset}
            >
              <span>返回成片 ×</span>
            </button>
          ) : (
            <span className="sr-only">共用播放头 · 播放最上层可见成片（空格键播放/暂停）</span>
          )}
        {previewFilm && !previewAsset && previewFilm.approvable && onToggleReview && (
          <button
            type="button"
            className={`h-7 shrink-0 rounded-lg px-3 text-xs font-medium transition ${
              previewFilm.approved
                ? 'btn-secondary text-ok'
                : 'btn-primary'
            }`}
            onClick={() => onToggleReview(previewFilm.planId, previewFilm.approved)}
            disabled={reviewBusy}
            aria-busy={reviewBusy}
          >
            {reviewBusy ? '正在保存…' : previewFilm.approved ? '✓ 已确认 · 点击撤销' : '确认这条'}
          </button>
        )}
        </div>
      </div>

      {reviewError && <p role="alert" className="shrink-0 bg-fail/10 px-3 py-2 text-xs text-fail">{reviewError}</p>}
      {!previewAsset && !!previewFilm?.sourceWarnings?.length && (
        <p role="status" className="shrink-0 bg-warn/10 px-3 py-2 text-xs text-warn">{previewFilm.sourceWarnings.join('；')}</p>
      )}
      <div className={styles.previewStageArea}>
        {sourceSession && onSourceApply ? (
          'edit' in sourceSession ? <FormulaManualMediaMonitor key={sourceSession.requestKey}
            session={sourceSession} projectId={projectId} onApply={onSourceApply} onClose={onClearPreviewAsset} />
          : <BatchSourceMonitor key={`${sourceSession.view.outputVersionId}:${sourceSession.view.editRevision}:${sourceSession.clipId}`}
            session={sourceSession} projectId={projectId} onApply={onSourceApply} onClose={onClearPreviewAsset} />
        ) : previewAsset ? (
          <div className="flex h-full w-full flex-col items-center justify-center p-2">
            {previewAsset.previewUrl ? (
              <LutVideoPlayer
                key={`preview-asset-${previewAsset.assetId}-${proxyPlayback ? 'proxy' : 'orig'}`}
                src={
                  proxyPlayback
                    ? previewAsset.previewUrl
                    : `/api/live-mixcut/assets/${encodeURIComponent(previewAsset.assetId)}/preview?projectId=${encodeURIComponent(projectId)}`
                }
                poster={previewAsset.thumbnailUrl}
                ariaLabel={`素材预览：${previewAsset.displayName}`}
                className="flex h-full min-h-0 items-center justify-center max-w-full"
                videoRef={materialVideoRef}
                lut={
                  previewAsset.lutId
                    ? {
                        lutId: previewAsset.lutId,
                        url: `/api/live-mixcut/luts/${encodeURIComponent(previewAsset.lutId)}/file?projectId=${encodeURIComponent(projectId)}`,
                      }
                    : null
                }
              />
            ) : previewAsset.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewAsset.thumbnailUrl}
                alt={previewAsset.displayName}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            ) : (
              <p className="text-xs text-ink-tertiary">素材无媒体预览</p>
            )}
          </div>
        ) : !previewFilm ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-ink-tertiary">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <p className="text-xs">全部成片已隐藏</p>
            <p className="text-[11px] opacity-75">点击时间轴任意成片左侧的眼睛图标恢复预览</p>
          </div>
        ) : !arrangement && previewFilm.formula ? (
          <FormulaOutputPreview key={`${projectId}:${batchId}:${previewFilm.planId}:${previewFilm.formula.stageId}`}
            projectId={projectId} batchId={batchId} planId={previewFilm.planId} outputPreset={outputPreset}
            playheadSec={playheadSec + INTRO_SEC} onSeek={handlePreviewSeek} />
        ) : isPastDuration ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-ink-tertiary">
            <p className="text-xs font-medium">此处没有画面</p>
            <p className="text-[11px] opacity-75">
              播放头 ({playheadSec.toFixed(1)}s) 已超出成片 {previewFilm.seq} 的正文时长 ({durationSec.toFixed(1)}s)
            </p>
          </div>
        ) : arrangement ? (
          <div className={styles.previewScreen}>
            {arrangement.formulaPreview && <div className="absolute left-2 top-2 z-20 rounded bg-surface px-2 py-1 text-[11px] text-ink-secondary" role="status">
              {arrangement.formulaPreview.message}
              {arrangement.formulaPreview.musicError && <p role="alert" className="text-fail">{arrangement.formulaPreview.musicError}</p>}
            </div>}
            <BatchTimelinePreview
              key={`${previewFilm.planId}:${packagingEditable}:${coverPreviewRequest}`}
              overlay={arrangement.packaging?.enabled ? <BatchPackagingOverlay key={`${previewFilm.planId}:${arrangement.editRevision}`} view={arrangement} editable={packagingEditable} onSave={onSourceApply}
                src={`/api/live-mixcut/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(previewFilm.planId)}/packaging-preview?projectId=${encodeURIComponent(projectId)}&format=html&edit=1&revision=${arrangement.editRevision}`}
                timeSec={playheadSec + INTRO_SEC} /> : null}
              clips={clips}
              narrationDurationUs={arrangement.narration?.durationUs}
              preserveGaps={arrangement.preserveGaps}
              audio={arrangement.audio}
              audioTimeline={arrangement.formulaPreview?.audioTimeline}
              assetsById={arrangement.formulaPreview ? { ...previewAssetsMap, ...arrangement.formulaPreview.assetsById } : previewAssetsMap}
              coverUrl={coverUrl}
              coverDraft={{
                asset: coverAsset,
                timeUs: arrangement.coverTimeUs,
                title: arrangement.packaging?.enabled ? null : arrangement.coverTitle,
                framing: arrangement.coverFraming,
              }}
              subtitleCues={arrangement.subtitleCues}
              subtitleStyle={arrangement.subtitleStyle}
              narrationUrl={narrationUrl}
              narrationGainDb={arrangement.narration?.gainDb ?? 0}
              bgm={previewBgm}
              outputPreset={outputPreset}
              playheadSec={playheadSec + INTRO_SEC}
              onSeek={handlePreviewSeek}
              active={true}
              compact={true}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-xs text-ink-tertiary" role="status">
            {previewFilm?.formula ? <>
              <p>成片尚未就绪，可在右侧查看选片记录。</p>
              <p>{previewFilm.formula.message}</p>
            </> : '正在载入成片安排…'}
          </div>
        )}
      </div>


    </section>
  );
}
