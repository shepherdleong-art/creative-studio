'use client';

import { useRef } from 'react';
import { FINAL_EDIT_FPS } from '@/lib/media-core/render-contract';
import { clamp } from '@/lib/one-click-film/packaging-edit';
import styles from './one-click-film.module.css';

export type TrackKind = 'subtitle' | 'packaging' | 'sticker' | 'picture' | 'voice' | 'music';
export type TimelineClip = {
  id: string;
  text: string;
  start: number;
  end: number;
  editable?: boolean;
  image?: string;
};
export type PackagingTrack = { kind: TrackKind; label: string; clips: TimelineClip[]; start?: number };
type Range = Pick<TimelineClip, 'start' | 'end'>;
type Edge = 'start' | 'end' | 'move';

function Clip({ clip, track, duration, active, onPick, onRange }: {
  clip: TimelineClip;
  track: PackagingTrack;
  duration: number;
  active: boolean;
  onPick: () => void;
  onRange: (range: Range, at: number) => void;
}) {
  const gesture = useRef<{ edge: Edge; x: number; range: Range; width: number; moved: boolean } | null>(null);
  const startDrag = (event: React.PointerEvent<HTMLElement>, edge: Edge) => {
    if (!clip.editable || event.button !== 0) return;
    const lane = event.currentTarget.closest<HTMLElement>('[data-track-lane]');
    if (!lane) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { edge, x: event.clientX, range: clip, width: lane.clientWidth, moved: false };
    onPick();
  };
  const drag = (event: React.PointerEvent<HTMLElement>) => {
    const state = gesture.current;
    if (!state || state.width <= 0) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 3) return;
    state.moved = true;
    const { start, end } = state.range;
    const minimum = Math.min(1 / FINAL_EDIT_FPS, end - start);
    const neighbors = track.kind === 'subtitle' ? track.clips.filter((item) => item.id !== clip.id) : [];
    const left = Math.max(track.start ?? 0, ...neighbors.filter((item) => item.end <= start).map((item) => item.end));
    const right = Math.min(duration, ...neighbors.filter((item) => item.start >= end).map((item) => item.start));
    const delta = Math.round(dx / state.width * duration * FINAL_EDIT_FPS) / FINAL_EDIT_FPS;
    let range: Range;
    if (state.edge === 'start') range = { start: clamp(start + delta, left, end - minimum), end };
    else if (state.edge === 'end') range = { start, end: clamp(end + delta, start + minimum, right) };
    else {
      const shift = clamp(delta, left - start, right - end);
      range = { start: start + shift, end: end + shift };
    }
    onRange(range, state.edge === 'end' ? Math.max(range.start, range.end - 1 / FINAL_EDIT_FPS) : range.start);
  };
  const cancel = () => {
    const state = gesture.current;
    if (state?.moved) onRange(state.range, state.range.start);
    gesture.current = null;
  };

  return <div className={styles.draftClip} data-active={active} data-editable={clip.editable}
    style={{ left: `${clip.start / duration * 100}%`, width: `${Math.max(0, clip.end - clip.start) / duration * 100}%` }}
    onPointerMove={drag} onPointerUp={() => { gesture.current = null; }} onPointerCancel={cancel}>
    <button type="button" title={clip.text} aria-current={track.kind === 'picture' ? active : undefined} onPointerDown={(event) => startDrag(event, 'move')}
      onClick={(event) => { if (event.detail === 0 || !clip.editable) onPick(); }}>
      {clip.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- 从成片取出的本地视频帧
        <img src={clip.image} alt="" draggable={false} />
      ) : null}
      <span>{clip.text}</span>
    </button>
    {clip.editable ? <>
      <span className={styles.draftTrimStart} aria-label={`调整${track.label}入点`} onPointerDown={(event) => startDrag(event, 'start')} />
      <span className={styles.draftTrimEnd} aria-label={`调整${track.label}出点`} onPointerDown={(event) => startDrag(event, 'end')} />
    </> : null}
  </div>;
}

export function PackagingTimeline({ tracks, duration, position, selected, onSeek, onPick, onRange }: {
  tracks: PackagingTrack[];
  duration: number;
  position: number;
  selected: string;
  onSeek: (time: number) => void;
  onPick: (track: TrackKind, clip: TimelineClip) => void;
  onRange: (track: TrackKind, clip: TimelineClip, range: Range, at: number) => void;
}) {
  return <section className={styles.draftTimeline} aria-label="审片时间轴">
    <div className={styles.draftTimelineHead}><b>审片时间轴</b><span className="tnum">{position.toFixed(2)} / {duration.toFixed(2)} 秒</span></div>
    <div className={styles.draftTracks}>
      <span className={styles.trackName}>时间</span>
      <div className={styles.draftRuler}>
        <div className={styles.rulerLabels} aria-hidden="true">{Array.from({ length: 6 }, (_, index) =>
          <span key={index}>{(duration * index / 5).toFixed(1)}s</span>)}</div>
        <input type="range" aria-label="审片时间轴播放头" className={styles.timelineScrubber}
          min={0} max={Math.round(duration * FINAL_EDIT_FPS)} value={Math.round(position * FINAL_EDIT_FPS)}
          onChange={(event) => onSeek(Number(event.currentTarget.value) / FINAL_EDIT_FPS)} />
      </div>
      {tracks.map((track) => <div className={styles.draftTrack} key={track.kind} role="group" aria-label={track.label} data-packaging-track={track.kind}>
        <span className={styles.trackName}>{track.label}</span>
        <div className={styles.draftLane} data-track-lane="" onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          onSeek((event.clientX - bounds.left) / bounds.width * duration);
        }}>
          {track.clips.map((clip) => <Clip key={clip.id} clip={clip} track={track} duration={duration}
            active={selected === clip.id} onPick={() => onPick(track.kind, clip)}
            onRange={(range, at) => onRange(track.kind, clip, range, at)} />)}
        </div>
      </div>)}
      <span className={styles.draftPlayhead} aria-hidden="true"><i style={{ left: `${position / duration * 100}%` }} /></span>
    </div>
  </section>;
}
