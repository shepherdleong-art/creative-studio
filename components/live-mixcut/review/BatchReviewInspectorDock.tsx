'use client';
import BatchPackagingEditor from '../BatchPackagingEditor';
import { humanizeBatchWarning } from '../batch-warning-text';
import { FormulaPresentationLocks } from '../formula/FormulaPresentationControls';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId, TextStyle } from '@/lib/media-core/cover-types';
import { defaultTextStyle } from '@/lib/media-core/cover-domain';
import { NARRATION_GAIN_DB_DEFAULT, NARRATION_GAIN_DB_MAX, NARRATION_GAIN_DB_MIN } from '@/lib/media-core/audio-gain';
import type { MusicDuckingConfig } from '@/lib/media-core/music-ducking';
import type { BatchOutputClipEditView, BatchOutputPoolAssetView } from '@/lib/live-mixcut/output-arrangement';
import { VideoPlaybackRateControl } from '@/components/mixcut/VideoPlaybackRateControl';
import { ClipFramingControl } from '@/components/mixcut/ClipFramingControl';
import BatchTextStyleEditor from '../BatchTextStyleEditor';
import BatchCoverDraftPreview from '../BatchCoverDraftPreview';
import BatchCoverEditorDrawer, { type BatchCoverEditorDraft } from '../BatchCoverEditorDrawer';
import type { InspectorTab, SelectionTarget, UnifiedFilmState } from './types';
import styles from './batch-unified-review.module.css';

export interface BatchReviewInspectorDockProps {
  projectId: string;
  batchId: string;
  outputPreset: OutputPresetId;
  film: UnifiedFilmState | null;
  selection: SelectionTarget | null;
  inspectorTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  poolAssets: BatchOutputPoolAssetView[];
  onMediaEdit: (planId: string, edit: Record<string, unknown>) => Promise<boolean>;
  onJumpToCover: (planId: string) => void;
  onRefreshFilm: (planId: string) => Promise<void>;
  coverEditorOpen: boolean;
  onOpenCoverEditor: () => void;
  onCloseCoverEditor: () => void;
}

export default function BatchReviewInspectorDock({
  projectId,
  batchId,
  outputPreset,
  film,
  selection,
  inspectorTab,
  onTabChange,
  poolAssets,
  onMediaEdit,
  onRefreshFilm,
  onJumpToCover,
  coverEditorOpen,
  onOpenCoverEditor,
  onCloseCoverEditor,
}: BatchReviewInspectorDockProps) {
  const arrangement = film?.arrangement;
  const planId = film?.planId;

  // Selected Clip
  const selectedClip = (arrangement?.clips && selection?.clipId)
    ? (arrangement.clips.find((c) => c.clipId === selection.clipId) ?? null)
    : null;

  // Selected Subtitle Cue
  const selectedCue = (arrangement?.subtitleCues && selection?.cueId)
    ? (arrangement.subtitleCues.find((c) => c.id === selection.cueId) ?? null)
    : null;

  const [prevCueId, setPrevCueId] = useState<string | null>(null);
  const [cueTextDraft, setCueTextDraft] = useState('');
  if (selectedCue && selectedCue.id !== prevCueId) {
    setPrevCueId(selectedCue.id);
    setCueTextDraft(selectedCue.text);
  }

  // Subtitle Style draft
  const defaultStyle = useMemo(
    () => defaultTextStyle('subtitle', outputPreset === '16x9' ? 1920 : 1080),
    [outputPreset]
  );
  const [prevSubPlanId, setPrevSubPlanId] = useState<string | null>(null);
  const [subtitleStyleDraft, setSubtitleStyleDraft] = useState<TextStyle | null>(null);
  if ((planId ?? null) !== prevSubPlanId) {
    setPrevSubPlanId(planId ?? null);
    setSubtitleStyleDraft(arrangement?.subtitleStyleOverride ? arrangement.subtitleStyle : null);
  }

  const effectiveSubtitleStyle = subtitleStyleDraft ?? arrangement?.subtitleStyle ?? defaultStyle;
  const subtitleStyleChanged =
    JSON.stringify(effectiveSubtitleStyle) !== JSON.stringify(arrangement?.subtitleStyle ?? defaultStyle);
  const canResetSubtitleStyle = !!arrangement?.subtitleStyleOverride;

  // Cover Drawer state
  const poolAssetsById = useMemo(() => new Map(poolAssets.map((a) => [a.assetId, a])), [poolAssets]);
  const coverAsset = arrangement?.coverAssetId ? (poolAssetsById.get(arrangement.coverAssetId) ?? null) : null;

  // Narration Gain Draft
  const [prevNarrPlanId, setPrevNarrPlanId] = useState<string | null>(null);
  const [narrationGainDraft, setNarrationGainDraft] = useState(NARRATION_GAIN_DB_DEFAULT);
  if ((planId ?? null) !== prevNarrPlanId) {
    setPrevNarrPlanId(planId ?? null);
    setNarrationGainDraft(arrangement?.narration?.gainDb ?? NARRATION_GAIN_DB_DEFAULT);
  }
  const narrationGainChanged = narrationGainDraft !== (arrangement?.narration?.gainDb ?? NARRATION_GAIN_DB_DEFAULT);

  // BGM draft
  const [musicSaving, setMusicSaving] = useState(false);
  const [prevMusicKey, setPrevMusicKey] = useState<string | null>(null);
  const musicKey = JSON.stringify([planId ?? null, arrangement?.outputVersionId, arrangement?.music]);
  const [musicDraft, setMusicDraft] = useState<{ trackId: string | null; gainDb: number; fadeInSec: number; fadeOutSec: number; ducking?: MusicDuckingConfig }>({
    trackId: null as string | null,
    gainDb: -18,
    fadeInSec: 1,
    fadeOutSec: 1.5,
  });
  if (musicKey !== prevMusicKey) {
    setPrevMusicKey(musicKey);
    if (arrangement?.music) {
      setMusicDraft({
        trackId: arrangement.music.trackId ?? null,
        gainDb: arrangement.music.gainDb ?? -18,
        fadeInSec: arrangement.music.fadeInSec ?? 1,
        fadeOutSec: arrangement.music.fadeOutSec ?? 1.5,
        ...(arrangement.music.ducking ? { ducking: { ...arrangement.music.ducking } } : {}),
      });
    }
  }

  const musicDefaults: BatchOutputClipEditView['batchMusicDefaults'] = arrangement?.batchMusicDefaults ?? { gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 };
  const musicDraftChanged = JSON.stringify(musicDraft) !== JSON.stringify(arrangement?.music ?? musicDefaults);
  const musicParamsMatchDefaults = musicDraft.gainDb === musicDefaults.gainDb
    && musicDraft.fadeInSec === musicDefaults.fadeInSec && musicDraft.fadeOutSec === musicDefaults.fadeOutSec
    && JSON.stringify(musicDraft.ducking) === JSON.stringify(musicDefaults.ducking);

  // Audio audition
  const [auditioning, setAuditioning] = useState(false);
  const [auditionError, setAuditionError] = useState('');
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);

  const toggleAudition = (trackId: string) => {
    if (auditioning) {
      auditionAudioRef.current?.pause();
      setAuditioning(false);
    } else {
      if (!auditionAudioRef.current) auditionAudioRef.current = new Audio();
      const saved = arrangement?.formulaPreview && arrangement.music.trackId === trackId;
      const url = saved ? arrangement.formulaPreview?.music?.fileUrl : `/api/final-edit-bgm/${encodeURIComponent(trackId)}/file`;
      if (!url) { setAuditionError('音乐来源无法读取，请重新选择。'); return; }
      setAuditionError('');
      auditionAudioRef.current.src = url;
      auditionAudioRef.current.play().catch(() => { setAuditionError('音乐试听失败，请检查文件或重新选曲。'); setAuditioning(false); });
      auditionAudioRef.current.onended = () => setAuditioning(false);
      setAuditioning(true);
    }
  };

  useEffect(() => {
    return () => {
      auditionAudioRef.current?.pause();
      auditionAudioRef.current = null;
    };
  }, []);

  if (!film) {
    return (
      <aside className={`${styles.dock} h-full`} aria-label="成片属性">
        <div className={styles.dockHead}>
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold text-ink">成片属性</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-ink-tertiary">
          请在下方时间轴选择一条已就绪成片
        </div>
      </aside>
    );
  }

  if (!arrangement) {
    return (
      <aside className={`${styles.dock} h-full`} aria-label="成片属性">
        <div className={styles.dockHead}>
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold text-ink">
              成片 {String(film.seq).padStart(2, '0')} · {film.scriptTitle || '未命名脚本'}
            </h3>
            <p className="text-[10px] text-ink-tertiary">这条成片还没有可编辑的画面、字幕和声音</p>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-ink-tertiary">
          {film.reviewable ? '正在读取成片编辑数据…' : '这条成片还在制作中，暂无可编辑内容。'}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`${styles.dock} h-full`} aria-label="成片属性">
      <div className={styles.dockHead}>
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold text-ink">
            成片 {String(film.seq).padStart(2, '0')} · {film.scriptTitle || '未命名脚本'}
          </h3>
          <p className="text-[10px] text-ink-tertiary">修改只作用于当前成片</p>
        </div>
      </div>

      <div className={styles.inspectorTabs}>
        <button type="button" className={`${styles.inspectorTabBtn} ${inspectorTab === 'packaging' ? styles.inspectorTabActive : ''}`} onClick={() => onTabChange('packaging')}>包装</button>
        <button
          type="button"
          className={`${styles.inspectorTabBtn} ${inspectorTab === 'subtitle' ? styles.inspectorTabActive : ''}`}
          onClick={() => onTabChange('subtitle')}
        >
          字幕
        </button>
        <button
          type="button"
          className={`${styles.inspectorTabBtn} ${inspectorTab === 'picture' ? styles.inspectorTabActive : ''}`}
          onClick={() => onTabChange('picture')}
        >
          画面
        </button>
        <button
          type="button"
          className={`${styles.inspectorTabBtn} ${inspectorTab === 'cover' ? styles.inspectorTabActive : ''}`}
          onClick={() => { onTabChange('cover'); onOpenCoverEditor(); }}
        >
          封面
        </button>
        <button
          type="button"
          className={`${styles.inspectorTabBtn} ${inspectorTab === 'audio' ? styles.inspectorTabActive : ''}`}
          onClick={() => onTabChange('audio')}
        >
          配音BGM
        </button>
      </div>

      <div className={styles.inspectorScroll}>
        {!!arrangement.reviewContext?.issues.length && <details className="mb-3 rounded-lg border border-line p-2 text-xs text-ink-secondary" data-testid="batch-review-issues">
          <summary className="cursor-pointer font-medium text-ink">本次确认包含的提醒（{arrangement.reviewContext.issues.length}）</summary>
          <ul className="mt-2 space-y-2">
            {arrangement.reviewContext.issues.map((issue, index) => <li key={index}>
              <p className={issue.kind === 'blocker' || issue.kind === 'audio' ? 'text-fail' : 'text-warn'}>{humanizeBatchWarning(issue.message)}</p>
              {issue.details?.map((detail, detailIndex) => <p key={detailIndex} className="mt-1">{detail}</p>)}
            </li>)}
          </ul>
        </details>}
        {(inspectorTab === 'packaging' || inspectorTab === 'cover') && <FormulaPresentationLocks
          key={`${film.planId}:${arrangement.outputVersionId}`} view={arrangement} onEdit={onMediaEdit} />}
        {inspectorTab === 'packaging' && <BatchPackagingEditor key={`${film.planId}:${arrangement.outputVersionId}`} view={arrangement} onJumpToCover={() => onJumpToCover(film.planId)}
          onSave={(config, reextract) => onMediaEdit(film.planId, { type: 'set_packaging', config, reextract, expectedEditRevision: arrangement.editRevision, expectedOutputVersionId: arrangement.outputVersionId })} />}
        {/* TAB 1: 字幕 */}
        {inspectorTab === 'subtitle' && (
          <div className="space-y-4">
            {selectedCue && (
              <div className="rounded-xl bg-surface-subtle p-3 space-y-2 border border-hairline">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">当前字幕文字</span>
                  <span className="text-[10px] tabular-nums text-ink-tertiary">
                    {(selectedCue.startUs / 1e6).toFixed(1)}s – {(selectedCue.endUs / 1e6).toFixed(1)}s
                  </span>
                </div>
                <textarea
                  className="w-full rounded-lg border border-hairline bg-surface p-2 text-xs leading-relaxed text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  rows={2}
                  value={cueTextDraft}
                  onChange={(e) => setCueTextDraft(e.target.value)}
                  onBlur={() => {
                    if (cueTextDraft !== selectedCue.text) {
                      void onMediaEdit(film.planId, {
                        type: 'set_subtitle_cue_text',
                        cueId: selectedCue.id,
                        text: cueTextDraft,
                      }).then(() => onRefreshFilm(film.planId));
                    }
                  }}
                />
                <p className="text-[10px] text-ink-tertiary">改字幕文字不改口播音频。</p>
              </div>
            )}

            <div className="rounded-xl bg-surface-subtle p-3 space-y-3 border border-hairline">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">字幕样式</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${arrangement.subtitleStyleOverride ? 'bg-warn/15 text-warn' : 'bg-ok/10 text-ok'}`}>
                  {arrangement.subtitleStyleOverride ? '本片覆盖' : '批次默认'}
                </span>
              </div>

              <BatchTextStyleEditor
                label="字幕样式"
                value={effectiveSubtitleStyle}
                outputWidth={outputPreset === '16x9' ? 1920 : 1080}
                onChange={setSubtitleStyleDraft}
              />

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
                <button
                  type="button"
                  className="btn-secondary h-7 px-2.5 text-xs"
                  disabled={!canResetSubtitleStyle}
                  onClick={() => {
                    void onMediaEdit(film.planId, { type: 'set_subtitle_style', style: null }).then(() => {
                      setSubtitleStyleDraft(null);
                      onRefreshFilm(film.planId);
                    });
                  }}
                >
                  恢复批次默认
                </button>
                <button
                  type="button"
                  className="btn-primary h-7 px-2.5 text-xs"
                  disabled={!subtitleStyleChanged}
                  onClick={() => {
                    void onMediaEdit(film.planId, {
                      type: 'set_subtitle_style',
                      style: effectiveSubtitleStyle,
                    }).then(() => onRefreshFilm(film.planId));
                  }}
                >
                  应用字幕样式
                </button>
              </div>

              {arrangement.subtitleOverride && (
                <button
                  type="button"
                  className="btn-secondary h-7 w-full text-xs"
                  onClick={() => {
                    void onMediaEdit(film.planId, { type: 'restore_automatic_subtitles' }).then(() =>
                      onRefreshFilm(film.planId)
                    );
                  }}
                >
                  恢复自动字幕
                </button>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: 画面 */}
        {inspectorTab === 'picture' && (
          <div className="space-y-4">
            {selectedClip ? (
              <>
                <VideoPlaybackRateControl
                  key={`speed:${selectedClip.clipId}`}
                  value={selectedClip.playbackRate ?? 1}
                  disabled={false}
                  onCommit={async (playbackRate) => {
                    const ok = await onMediaEdit(film.planId, {
                      type: 'set_clip_playback_rate',
                      clipId: selectedClip.clipId,
                      playbackRate,
                    });
                    if (ok) await onRefreshFilm(film.planId);
                    return ok;
                  }}
                />

                <ClipFramingControl
                  key={`framing:${selectedClip.clipId}`}
                  clip={{ framing: selectedClip.framing ?? { scale: 1, offsetX: 0, offsetY: 0 } }}
                  disabled={false}
                  onPreview={() => {}}
                  onCommit={(framing) => {
                    void onMediaEdit(film.planId, {
                      type: 'set_clip_framing',
                      clipId: selectedClip.clipId,
                      framing,
                    }).then(() => onRefreshFilm(film.planId));
                  }}
                />
              </>
            ) : (
              <div className="rounded-xl bg-surface-subtle p-6 text-center text-xs text-ink-tertiary">
                请在时间轴点击一个视频片段来调节其倍速与画面构图
              </div>
            )}
          </div>
        )}

        {/* TAB 3: 封面 */}
        {inspectorTab === 'cover' && (
          <div className="rounded-xl bg-surface-subtle p-3 space-y-3 border border-hairline">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink">视频封面设置</span>
              <span className="text-[10px] text-ink-tertiary">点击精调</span>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <BatchCoverDraftPreview
                  asset={coverAsset}
                  timeUs={arrangement.coverTimeUs}
                  title={arrangement.packaging?.enabled ? null : arrangement.coverTitle}
                  framing={arrangement.coverFraming}
                  outputPreset={outputPreset}
                />
              </div>

              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-xs font-medium text-ink" title={coverAsset?.displayName}>
                  {coverAsset?.displayName || '尚未选择封面素材'}
                </p>
                <p className="text-[10px] text-ink-tertiary">
                  {coverAsset ? `截帧 ${(arrangement.coverTimeUs / 1e6).toFixed(2)}s` : '选择视频片段作为封面'}
                </p>
                <button
                  type="button"
                  className="btn-secondary mt-1 inline-flex h-7 items-center gap-1 px-2.5 text-xs text-accent"
                  onClick={onOpenCoverEditor}
                >
                  <span>封面精调</span>
                  <Icon name="chevron-right" size={11} />
                </button>
              </div>
            </div>

            <BatchCoverEditorDrawer
              key={film.planId}
              active={coverEditorOpen}
              assets={poolAssets}
              initialAssetId={arrangement.coverAssetId}
              initialTimeUs={arrangement.coverTimeUs}
              title={arrangement.coverTitle}
              framing={arrangement.coverFraming}
              outputPreset={outputPreset}
              packaging={arrangement.packaging}
              packagingPreviewUrl={`/api/live-mixcut/batches/${encodeURIComponent(batchId)}/outputs/${encodeURIComponent(film.planId)}/packaging-preview?projectId=${encodeURIComponent(projectId)}`}
              version={arrangement.outputVersionId ? { editRevision: arrangement.editRevision, outputVersionId: arrangement.outputVersionId } : undefined}
              busy={!arrangement.editable}
              onClose={onCloseCoverEditor}
              onApply={async (draft: BatchCoverEditorDraft) => {
                const ok = await onMediaEdit(film.planId, {
                  type: 'set_cover',
                  assetId: draft.assetId,
                  timeUs: draft.timeUs,
                  framing: draft.framing,
                  title: !draft.packaging?.enabled || draft.titleEdited ? draft.title : undefined,
                  packaging: draft.packaging,
                  expectedEditRevision: draft.expectedEditRevision,
                  expectedOutputVersionId: draft.expectedOutputVersionId,
                });
                if (ok) await onRefreshFilm(film.planId);
                return ok;
              }}
            />
          </div>
        )}

        {/* TAB 4: 配音与 BGM */}
        {inspectorTab === 'audio' && (
          <div className="space-y-4">
            {/* 口播音量 */}
            <div className="rounded-xl bg-surface-subtle p-3 space-y-2 border border-hairline">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">成片口播音量</span>
                <span className="text-[10px] tabular-nums text-ink-secondary">{narrationGainDraft.toFixed(0)} dB</span>
              </div>
              <p className="text-[10px] text-ink-tertiary">只调整当前成片的口播响度，不改变音频内容与时长。</p>
              <input
                type="range"
                min={NARRATION_GAIN_DB_MIN}
                max={NARRATION_GAIN_DB_MAX}
                step={1}
                value={narrationGainDraft}
                onChange={(e) => setNarrationGainDraft(Number(e.target.value))}
                className="w-full accent-accent"
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="btn-secondary h-7 px-2 text-xs"
                  disabled={!narrationGainChanged}
                  onClick={() => setNarrationGainDraft(NARRATION_GAIN_DB_DEFAULT)}
                >
                  恢复默认
                </button>
                <button
                  type="button"
                  className="btn-primary h-7 px-2 text-xs"
                  disabled={!narrationGainChanged}
                  onClick={() => {
                    void onMediaEdit(film.planId, {
                      type: 'set_narration_gain',
                      gainDb: narrationGainDraft,
                    }).then(() => onRefreshFilm(film.planId));
                  }}
                >
                  应用音量
                </button>
              </div>
            </div>

            {/* 成片背景音乐 */}
            <fieldset disabled={musicSaving} aria-busy={musicSaving} className="min-w-0 rounded-xl bg-surface-subtle p-3 space-y-3 border border-hairline">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">成片背景音乐</span>
                <span className="text-[10px] text-ink-tertiary">每条成片可单独覆盖</span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  aria-label="成片背景音乐"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink focus:outline-none"
                  value={musicDraft.trackId ?? ''}
                  onChange={(e) => {
                    auditionAudioRef.current?.pause(); setAuditioning(false); setAuditionError('');
                    setMusicDraft((c) => ({ ...c, trackId: e.target.value || null }));
                  }}
                >
                  <option value="">关闭 BGM</option>
                  {arrangement.musicLibrary?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.filename} · {(t.durationUs / 1e6).toFixed(1)}s
                    </option>
                  ))}
                </select>

                {musicDraft.trackId && (
                  <button
                    type="button"
                    className="btn-secondary h-8 px-2.5 text-xs"
                    onClick={() => toggleAudition(musicDraft.trackId!)}
                  >
                    {auditioning ? '停止试听' : '试听'}
                  </button>
                )}
              </div>

              {auditionError && <p role="alert" className="text-xs text-fail">{auditionError}</p>}
              {musicDraft.trackId && (
                <div className="space-y-2">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-ink-secondary">
                      <span>音乐音量</span>
                      <span className="tabular-nums">{musicDraft.gainDb.toFixed(0)} dB</span>
                    </div>
                    <input
                      type="range"
                      min={-60}
                      max={0}
                      step={1}
                      value={musicDraft.gainDb}
                      aria-label="背景音乐音量"
                      onChange={(e) => setMusicDraft((c) => ({ ...c, gainDb: Number(e.target.value) }))}
                      className="w-full accent-accent"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-ink-secondary">
                        <span>淡入</span>
                        <span>{musicDraft.fadeInSec.toFixed(1)}s</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={30}
                        step={0.1}
                        value={musicDraft.fadeInSec}
                        aria-label="背景音乐淡入时间"
                        onChange={(e) => setMusicDraft((c) => ({ ...c, fadeInSec: Number(e.target.value) }))}
                        className="w-full accent-accent"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-ink-secondary">
                        <span>淡出</span>
                        <span>{musicDraft.fadeOutSec.toFixed(1)}s</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={30}
                        step={0.1}
                        value={musicDraft.fadeOutSec}
                        aria-label="背景音乐淡出时间"
                        onChange={(e) => setMusicDraft((c) => ({ ...c, fadeOutSec: Number(e.target.value) }))}
                        className="w-full accent-accent"
                      />
                    </div>
                  </div>
                  {musicDraft.ducking && <div className="space-y-2 border-t border-hairline pt-2">
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input type="checkbox" className="accent-accent" checked={musicDraft.ducking.enabled}
                        onChange={event => setMusicDraft(current => ({ ...current, ducking: { ...current.ducking!, enabled: event.target.checked } }))} />
                      说话时压低音乐
                    </label>
                    <p className="text-[10px] text-ink-secondary">原声和配音都生效。应用后播放成片试听，右侧“试听”只播放曲目。</p>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['reductionDb', '再降低 dB', 24, 1], ['attackMs', '压低 ms', 2000, 10], ['releaseMs', '恢复 ms', 5000, 10],
                      ] as const).map(([key, label, max, step]) => <label key={key} className="space-y-1 text-[10px] text-ink-secondary">
                        <span>{label}</span>
                        <input type="number" aria-label={`音乐${label}`} min={0} max={max} step={step}
                          disabled={!musicDraft.ducking!.enabled} value={musicDraft.ducking![key]}
                          className="h-7 w-full rounded border border-hairline bg-surface px-1 text-xs text-ink disabled:opacity-50"
                          onChange={event => setMusicDraft(current => ({ ...current, ducking: { ...current.ducking!, [key]: Number(event.target.value) } }))} />
                      </label>)}
                    </div>
                  </div>}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
                <button
                  type="button"
                  className="btn-secondary h-7 px-2 text-xs"
                  disabled={musicParamsMatchDefaults}
                  onClick={() => setMusicDraft((c) => ({ ...c, ...musicDefaults }))}
                >
                  恢复批次默认
                </button>
                <button
                  type="button"
                  className="btn-primary h-7 px-2 text-xs"
                  disabled={!musicDraftChanged}
                  onClick={async () => {
                    if (musicSaving) return;
                    setMusicSaving(true);
                    try {
                      const saved = await onMediaEdit(film.planId, {
                        type: 'set_music',
                        trackId: musicDraft.trackId,
                        gainDb: musicDraft.gainDb,
                        fadeInSec: musicDraft.fadeInSec,
                        fadeOutSec: musicDraft.fadeOutSec,
                        ...(musicDraft.ducking ? { ducking: musicDraft.ducking } : {}),
                      });
                      if (saved) await onRefreshFilm(film.planId);
                    } finally { setMusicSaving(false); }
                  }}
                >
                  {musicSaving ? '保存中…' : '应用 BGM 更改'}
                </button>
              </div>
            </fieldset>
          </div>
        )}
      </div>
    </aside>
  );
}
