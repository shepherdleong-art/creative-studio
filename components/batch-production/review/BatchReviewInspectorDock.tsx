'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { OutputPresetId, TextStyle } from '@/lib/media-core/cover-types';
import { defaultTextStyle } from '@/lib/media-core/cover-domain';
import { NARRATION_GAIN_DB_DEFAULT, NARRATION_GAIN_DB_MAX, NARRATION_GAIN_DB_MIN } from '@/lib/media-core/audio-gain';
import type { BatchOutputPoolAssetView } from '@/lib/batch-production/output-arrangement';
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
  onRefreshFilm: (planId: string) => Promise<void>;
}

export default function BatchReviewInspectorDock({
  outputPreset,
  film,
  selection,
  inspectorTab,
  onTabChange,
  poolAssets,
  onMediaEdit,
  onRefreshFilm,
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
  const [coverEditorOpen, setCoverEditorOpen] = useState(false);
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
  const [prevMusicPlanId, setPrevMusicPlanId] = useState<string | null>(null);
  const [musicDraft, setMusicDraft] = useState({
    trackId: null as string | null,
    gainDb: -18,
    fadeInSec: 1,
    fadeOutSec: 1.5,
  });
  if ((planId ?? null) !== prevMusicPlanId) {
    setPrevMusicPlanId(planId ?? null);
    if (arrangement?.music) {
      setMusicDraft({
        trackId: arrangement.music.trackId ?? null,
        gainDb: arrangement.music.gainDb ?? -18,
        fadeInSec: arrangement.music.fadeInSec ?? 1,
        fadeOutSec: arrangement.music.fadeOutSec ?? 1.5,
      });
    }
  }

  const musicDefaults = arrangement?.batchMusicDefaults ?? { trackId: null, gainDb: -18, fadeInSec: 1, fadeOutSec: 1.5 };
  const musicDraftChanged = JSON.stringify(musicDraft) !== JSON.stringify(arrangement?.music ?? musicDefaults);
  const musicParamsMatchDefaults = JSON.stringify(musicDraft) === JSON.stringify(musicDefaults);

  // Audio audition
  const [auditioning, setAuditioning] = useState(false);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);

  const toggleAudition = (trackId: string) => {
    if (auditioning) {
      auditionAudioRef.current?.pause();
      setAuditioning(false);
    } else {
      if (!auditionAudioRef.current) auditionAudioRef.current = new Audio();
      auditionAudioRef.current.src = `/api/final-edit-bgm/${encodeURIComponent(trackId)}/file`;
      auditionAudioRef.current.play().catch(() => {});
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

  if (!film || !arrangement) {
    return (
      <aside className={`${styles.dock} h-full`} aria-label="成片属性">
        <div className={styles.dockHead}>
          <h3 className="text-xs font-semibold text-ink">属性检查器</h3>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-ink-tertiary">
          请在时间轴点击选择一条成片
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
          onClick={() => onTabChange('cover')}
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
                  title={arrangement.coverTitle}
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
                  onClick={() => setCoverEditorOpen(true)}
                >
                  <span>封面精调</span>
                  <Icon name="chevron-right" size={11} />
                </button>
              </div>
            </div>

            <BatchCoverEditorDrawer
              active={coverEditorOpen}
              assets={poolAssets}
              initialAssetId={arrangement.coverAssetId}
              initialTimeUs={arrangement.coverTimeUs}
              title={arrangement.coverTitle}
              framing={arrangement.coverFraming}
              outputPreset={outputPreset}
              busy={false}
              onClose={() => setCoverEditorOpen(false)}
              onApply={async (draft: BatchCoverEditorDraft) => {
                const ok = await onMediaEdit(film.planId, {
                  type: 'set_cover',
                  assetId: draft.assetId,
                  timeUs: draft.timeUs,
                  framing: draft.framing,
                  title: draft.title,
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
            <div className="rounded-xl bg-surface-subtle p-3 space-y-3 border border-hairline">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">成片背景音乐</span>
                <span className="text-[10px] text-ink-tertiary">每条成片可单独覆盖</span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink focus:outline-none"
                  value={musicDraft.trackId ?? ''}
                  onChange={(e) => setMusicDraft((c) => ({ ...c, trackId: e.target.value || null }))}
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
                        onChange={(e) => setMusicDraft((c) => ({ ...c, fadeOutSec: Number(e.target.value) }))}
                        className="w-full accent-accent"
                      />
                    </div>
                  </div>
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
                  onClick={() => {
                    void onMediaEdit(film.planId, {
                      type: 'set_music',
                      trackId: musicDraft.trackId,
                      gainDb: musicDraft.gainDb,
                      fadeInSec: musicDraft.fadeInSec,
                      fadeOutSec: musicDraft.fadeOutSec,
                    }).then(() => onRefreshFilm(film.planId));
                  }}
                >
                  应用 BGM 更改
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
