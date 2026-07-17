'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { FinalEditAssetView, FinalEditVariantView, SubtitleCue, TimelineClip } from '@/lib/final-edit/types';
import styles from './FinalEditEditor.module.css';

const FPS = 24;
const INTRO_US = 20 / FPS * 1_000_000;

export function FinalEditTimeline({
  variant,
  cues,
  assets,
  selectedCueId,
  selectedClipId,
  playheadSec,
  onSeek,
  onSelectCue,
  onSelectClip,
  onMoveCue,
  onTrimCue,
  onMoveClip,
  onTrimClip,
  onDeleteClip,
  onInsertAsset,
}: {
  variant: FinalEditVariantView;
  cues: SubtitleCue[];
  assets: FinalEditAssetView[];
  selectedCueId: string;
  selectedClipId: string;
  playheadSec: number;
  onSeek: (timeSec: number) => void;
  onSelectCue: (id: string) => void;
  onSelectClip: (id: string) => void;
  onMoveCue: (id: string, startUs: number, endUs: number) => void;
  onTrimCue: (id: string, startUs: number, endUs: number) => void;
  onMoveClip: (id: string, timelineInFrame: number) => void;
  onTrimClip: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => void;
  onDeleteClip: (id: string) => void;
  onInsertAsset: (asset: FinalEditAssetView, timelineInFrame: number) => void;
}) {
  const bodyUs = variant.timeline.bodyFrames / FPS * 1_000_000;
  const totalUs = INTRO_US + bodyUs;
  const totalSec = totalUs / 1_000_000;
  const ticks = Array.from({ length: Math.max(2, Math.ceil(totalSec / 5) + 1) }, (_, index) => Math.min(totalSec, index * 5));
  const assetById = new Map(assets.map((asset) => [asset.videoJobId, asset]));
  const left = (timeUs: number) => `${timeUs / totalUs * 100}%`;
  const width = (timeUs: number) => `${timeUs / totalUs * 100}%`;

  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(totalSec, (event.clientX - rect.left) / Math.max(1, rect.width) * totalSec)));
  };

  const dropAsset = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const videoJobId = event.dataTransfer.getData('application/x-final-edit-asset') || event.dataTransfer.getData('text/plain');
    const asset = assetById.get(videoJobId);
    if (!asset) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const absoluteUs = Math.max(INTRO_US, Math.min(totalUs, (event.clientX - rect.left) / Math.max(1, rect.width) * totalUs));
    onInsertAsset(asset, Math.max(0, Math.min(variant.timeline.bodyFrames - 1, Math.round((absoluteUs - INTRO_US) / 1_000_000 * FPS))));
  };

  return (
    <section className={styles.timelineShell} aria-label="成片时间轴">
      <div className={styles.timelineToolbar}>
        <strong>时间轴</strong>
        <span>20 帧封面 · 正文 {(bodyUs / 1_000_000).toFixed(2)}s · 拖入素材或拖动片段与字幕边缘</span>
      </div>
      <div className={styles.timelineGrid}>
        <div className={styles.trackLabels}>
          <div className={styles.rulerSpacer} />
          {['字幕', '视频', 'TTS', 'BGM'].map((label) => <div className={styles.trackLabel} key={label}>{label}</div>)}
        </div>
        <div className={styles.timelineViewport} onPointerDown={seekFromPointer}>
          <div className={styles.ruler}>{ticks.map((tick) => <span key={tick} style={{ left: `${tick / totalSec * 100}%` }}>{tick.toFixed(0)}s</span>)}</div>
          <div className={styles.track}>
            {cues.map((cue) => (
              <CueBlock key={`${cue.id}-${cue.startUs}-${cue.endUs}`} cue={cue} selected={cue.id === selectedCueId} bodyUs={bodyUs} totalUs={totalUs} onSelect={onSelectCue} onMove={onMoveCue} onTrim={onTrimCue} />
            ))}
          </div>
          <div className={styles.track} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropAsset}>
            <div className={styles.coverBlock} style={{ left: 0, width: width(INTRO_US) }}>封面</div>
            {variant.timeline.clips.map((clip) => (
              <ClipBlock
                key={`${clip.id}-${clip.sourceInFrame}-${clip.sourceOutFrame}-${clip.timelineInFrame}-${clip.timelineOutFrame}`}
                clip={clip}
                thumbnailUrl={assetById.get(clip.videoJobId)?.thumbnailUrl}
                selected={selectedClipId === clip.id}
                bodyFrames={variant.timeline.bodyFrames}
                totalUs={totalUs}
                onSelect={onSelectClip}
                onMove={onMoveClip}
                onTrim={onTrimClip}
                onDelete={onDeleteClip}
              />
            ))}
          </div>
          <div className={styles.track}><div className={styles.audioBlock} style={{ left: left(INTRO_US), width: width(bodyUs) }}><span>锁定口播</span><span>原声</span></div></div>
          <div className={styles.track}><div className={`${styles.audioBlock} ${styles.bgmBlock}`} style={{ left: left(INTRO_US), width: width(bodyUs) }}><span>{variant.bgm.trackId ? `${variant.bgm.gainDb} dB` : '无 BGM'}</span><span>淡出 {variant.bgm.fadeOutSec}s</span></div></div>
          <div className={styles.playhead} style={{ left: `${playheadSec / totalSec * 100}%` }} />
        </div>
      </div>
      {variant.issues.length > 0 && (
        <div className={styles.issueBar}><span>{variant.issues.filter((issue) => issue.severity === 'blocking').length ? '存在阻断问题，修复后才能导出' : `${variant.issues.length} 个提醒`}</span><span>{variant.issues[0]?.message}</span></div>
      )}
    </section>
  );
}

function CueBlock({ cue, selected, bodyUs, totalUs, onSelect, onMove, onTrim }: {
  cue: SubtitleCue;
  selected: boolean;
  bodyUs: number;
  totalUs: number;
  onSelect: (id: string) => void;
  onMove: (id: string, startUs: number, endUs: number) => void;
  onTrim: (id: string, startUs: number, endUs: number) => void;
}) {
  const [draft, setDraft] = useState({ startUs: cue.startUs, endUs: cue.endUs });
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); onSelect(cue.id);
    const track = event.currentTarget.closest('[data-cue-block]')?.parentElement;
    if (!track) return;
    const startX = event.clientX;
    const initial = { ...draft };
    let latest = initial;
    const frameUs = 1_000_000 / FPS;
    const movePointer = (pointer: PointerEvent) => {
      const deltaUs = Math.round((pointer.clientX - startX) / Math.max(1, track.getBoundingClientRect().width) * totalUs / frameUs) * frameUs;
      if (mode === 'move') {
        const duration = initial.endUs - initial.startUs;
        const startUs = Math.max(0, Math.min(bodyUs - duration, initial.startUs + deltaUs));
        latest = { startUs, endUs: startUs + duration };
      } else if (mode === 'start') {
        latest = { startUs: Math.max(0, Math.min(initial.endUs - frameUs, initial.startUs + deltaUs)), endUs: initial.endUs };
      } else {
        latest = { startUs: initial.startUs, endUs: Math.min(bodyUs, Math.max(initial.startUs + frameUs, initial.endUs + deltaUs)) };
      }
      setDraft(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', up);
      const commit = mode === 'move' ? onMove : onTrim;
      commit(cue.id, Math.round(latest.startUs), Math.round(latest.endUs));
    };
    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div data-cue-block role="button" tabIndex={0} className={`${styles.cueBlock} ${selected ? styles.selectedBlock : ''}`} style={{ left: `${(INTRO_US + draft.startUs) / totalUs * 100}%`, width: `${(draft.endUs - draft.startUs) / totalUs * 100}%` }} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(cue.id); }} onPointerDown={(event) => begin('move', event)}>
      <div className={styles.cueHandle} onPointerDown={(event) => begin('start', event)} />
      <b>{cue.text}</b>
      <div className={styles.cueHandle} onPointerDown={(event) => begin('end', event)} />
    </div>
  );
}

function ClipBlock({ clip, thumbnailUrl, selected, bodyFrames, totalUs, onSelect, onMove, onTrim, onDelete }: {
  clip: TimelineClip;
  thumbnailUrl?: string;
  selected: boolean;
  bodyFrames: number;
  totalUs: number;
  onSelect: (id: string) => void;
  onMove: (id: string, timelineInFrame: number) => void;
  onTrim: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState({ sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame });
  const begin = (mode: 'move' | 'start' | 'end', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); onSelect(clip.id);
    const track = event.currentTarget.closest('[data-clip-block]')?.parentElement;
    if (!track) return;
    const startX = event.clientX;
    const initial = { ...draft };
    let latest = initial;
    const movePointer = (pointer: PointerEvent) => {
      const deltaFrames = Math.round((pointer.clientX - startX) / Math.max(1, track.getBoundingClientRect().width) * totalUs / 1_000_000 * FPS);
      if (mode === 'move') {
        const duration = initial.timelineOutFrame - initial.timelineInFrame;
        const timelineInFrame = Math.max(0, Math.min(bodyFrames - duration, initial.timelineInFrame + deltaFrames));
        latest = { ...initial, timelineInFrame, timelineOutFrame: timelineInFrame + duration };
      } else if (mode === 'start') {
        const delta = Math.max(-Math.min(initial.timelineInFrame, initial.sourceInFrame), Math.min(initial.timelineOutFrame - initial.timelineInFrame - 1, deltaFrames));
        latest = { ...initial, sourceInFrame: initial.sourceInFrame + delta, timelineInFrame: initial.timelineInFrame + delta };
      } else {
        const delta = Math.max(-(initial.timelineOutFrame - initial.timelineInFrame - 1), Math.min(bodyFrames - initial.timelineOutFrame, deltaFrames));
        latest = { ...initial, sourceOutFrame: initial.sourceOutFrame + delta, timelineOutFrame: initial.timelineOutFrame + delta };
      }
      setDraft(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', up);
      if (mode === 'move') onMove(clip.id, latest.timelineInFrame);
      else onTrim(clip.id, latest.sourceInFrame, latest.sourceOutFrame, latest.timelineInFrame, latest.timelineOutFrame);
    };
    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div data-clip-block role="button" tabIndex={0} className={`${styles.clipBlock} ${selected ? styles.selectedBlock : ''}`} style={{ left: `${(INTRO_US + draft.timelineInFrame / FPS * 1_000_000) / totalUs * 100}%`, width: `${((draft.timelineOutFrame - draft.timelineInFrame) / FPS * 1_000_000) / totalUs * 100}%`, backgroundImage: thumbnailUrl ? `url(${JSON.stringify(thumbnailUrl).slice(1, -1)})` : undefined }} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(clip.id); }} onPointerDown={(event) => begin('move', event)}>
      <div className={styles.clipHandle} onPointerDown={(event) => begin('start', event)} />
      <b>{clip.videoJobId.slice(0, 8)}</b>
      <button type="button" aria-label="删除片段" className={styles.danger} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onDelete(clip.id); }}><Icon name="trash" size={11} /></button>
      <div className={styles.clipHandle} onPointerDown={(event) => begin('end', event)} />
    </div>
  );
}
