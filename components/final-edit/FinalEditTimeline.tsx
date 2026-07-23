'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { timelineGaps } from '@/lib/final-edit/domain';
import type { FinalEditAssetView, FinalEditVariantView, SubtitleCue, TimelineClip } from '@/lib/final-edit/types';
import { constrainClipDrag, type ClipDraft, type ClipDragMode } from './timeline-edit';
import styles from './FinalEditEditor.module.css';

const FPS = 24;
const INTRO_US = 20 / FPS * 1_000_000;

export function FinalEditTimeline({
  variant,
  cues,
  assets,
  overflowCueIds,
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
  onRepairIssues,
  repairingIssues,
}: {
  variant: FinalEditVariantView;
  cues: SubtitleCue[];
  assets: FinalEditAssetView[];
  overflowCueIds: string[];
  selectedCueId: string;
  selectedClipId: string;
  playheadSec: number;
  onSeek: (timeSec: number) => void;
  onSelectCue: (id: string) => void;
  onSelectClip: (id: string) => void;
  onMoveCue: (id: string, startUs: number, endUs: number) => void;
  onTrimCue: (id: string, startUs: number, endUs: number) => void;
  onMoveClip: (id: string, timelineInFrame: number) => Promise<boolean>;
  onTrimClip: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => Promise<boolean>;
  onDeleteClip: (id: string) => void;
  onInsertAsset: (asset: FinalEditAssetView, timelineInFrame: number) => void;
  onRepairIssues: () => void;
  repairingIssues: boolean;
}) {
  const bodyUs = variant.timeline.bodyFrames / FPS * 1_000_000;
  const totalUs = INTRO_US + bodyUs;
  const totalSec = totalUs / 1_000_000;
  const ticks = Array.from({ length: Math.max(2, Math.ceil(totalSec / 5) + 1) }, (_, index) => Math.min(totalSec, index * 5));
  const assetById = new Map(assets.map((asset) => [asset.videoJobId, asset]));
  const left = (timeUs: number) => `${timeUs / totalUs * 100}%`;
  const width = (timeUs: number) => `${timeUs / totalUs * 100}%`;
  const blockingIssues = variant.issues.filter((issue) => issue.severity === 'blocking');
  const primaryIssue = blockingIssues[0] || variant.issues[0];
  const videoGaps = timelineGaps(variant.timeline.bodyFrames, variant.timeline.clips);

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
              <CueBlock key={`${cue.id}-${cue.startUs}-${cue.endUs}`} cue={cue} selected={cue.id === selectedCueId} overflow={overflowCueIds.includes(cue.id)} bodyUs={bodyUs} totalUs={totalUs} onSelect={onSelectCue} onMove={onMoveCue} onTrim={onTrimCue} />
            ))}
          </div>
          <div className={styles.track} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropAsset}>
            <div className={styles.coverBlock} style={{ left: 0, width: width(INTRO_US) }}>封面</div>
            {videoGaps.map((gap) => <div key={`${gap.startFrame}-${gap.endFrame}`} className={styles.videoGapBlock} aria-label={`画面缺口 ${gap.startFrame}–${gap.endFrame} 帧`} style={{ left: left(INTRO_US + gap.startFrame / FPS * 1_000_000), width: width((gap.endFrame - gap.startFrame) / FPS * 1_000_000) }} />)}
            {variant.timeline.clips.map((clip) => (
              <ClipBlock
                key={`${clip.id}-${clip.sourceInFrame}-${clip.sourceOutFrame}-${clip.timelineInFrame}-${clip.timelineOutFrame}`}
                clip={clip}
                clips={variant.timeline.clips}
                thumbnailUrl={assetById.get(clip.videoJobId)?.thumbnailUrl}
                sourceFrames={Math.floor((assetById.get(clip.videoJobId)?.durationUs || 0) / 1_000_000 * FPS)}
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
        <div className={styles.issueBar}>
          <div className={styles.issueBarMessage}><strong>{blockingIssues.length ? '存在阻断问题，修复后才能导出' : `${variant.issues.length} 个提醒`}</strong><span>{primaryIssue?.message}</span></div>
          {blockingIssues.length > 0 && <button type="button" className={styles.repairButton} disabled={repairingIssues} onClick={onRepairIssues}>{repairingIssues ? '正在修复…' : '一键修复'}</button>}
        </div>
      )}
    </section>
  );
}

function CueBlock({ cue, selected, overflow, bodyUs, totalUs, onSelect, onMove, onTrim }: {
  cue: SubtitleCue;
  selected: boolean;
  overflow: boolean;
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
    <div data-cue-block data-text-overflow={overflow || undefined} role="button" tabIndex={0} aria-label={overflow ? `字幕超宽：${cue.text}` : cue.text} className={`${styles.cueBlock} ${selected ? styles.selectedBlock : ''} ${overflow ? styles.overflowCueBlock : ''}`} style={{ left: `${(INTRO_US + draft.startUs) / totalUs * 100}%`, width: `${(draft.endUs - draft.startUs) / totalUs * 100}%` }} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(cue.id); }} onPointerDown={(event) => begin('move', event)}>
      <div className={styles.cueHandle} onPointerDown={(event) => begin('start', event)} />
      {overflow && <span className={styles.overflowBadge}>超宽</span>}
      <b>{cue.text}</b>
      <div className={styles.cueHandle} onPointerDown={(event) => begin('end', event)} />
    </div>
  );
}

function ClipBlock({ clip, clips, thumbnailUrl, sourceFrames, selected, bodyFrames, totalUs, onSelect, onMove, onTrim, onDelete }: {
  clip: TimelineClip;
  clips: TimelineClip[];
  thumbnailUrl?: string;
  sourceFrames: number;
  selected: boolean;
  bodyFrames: number;
  totalUs: number;
  onSelect: (id: string) => void;
  onMove: (id: string, timelineInFrame: number) => Promise<boolean>;
  onTrim: (id: string, sourceInFrame: number, sourceOutFrame: number, timelineInFrame: number, timelineOutFrame: number) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<ClipDraft>({ sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame });
  const begin = (mode: ClipDragMode, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); onSelect(clip.id);
    const track = event.currentTarget.closest('[data-clip-block]')?.parentElement;
    if (!track) return;
    const startX = event.clientX;
    const initial = { ...draft };
    let latest = initial;
    const movePointer = (pointer: PointerEvent) => {
      const deltaFrames = Math.round((pointer.clientX - startX) / Math.max(1, track.getBoundingClientRect().width) * totalUs / 1_000_000 * FPS);
      latest = constrainClipDrag({ clip: { ...clip, ...initial }, clips, bodyFrames, sourceFrames, mode, deltaFrames });
      setDraft(latest);
    };
    const up = async () => {
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', up);
      if (latest.sourceInFrame === initial.sourceInFrame && latest.sourceOutFrame === initial.sourceOutFrame && latest.timelineInFrame === initial.timelineInFrame && latest.timelineOutFrame === initial.timelineOutFrame) return;
      const accepted = mode === 'move'
        ? await onMove(clip.id, latest.timelineInFrame)
        : await onTrim(clip.id, latest.sourceInFrame, latest.sourceOutFrame, latest.timelineInFrame, latest.timelineOutFrame);
      if (!accepted) setDraft(initial);
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
