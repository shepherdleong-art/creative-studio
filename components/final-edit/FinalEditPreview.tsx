'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FinalEditAssetView, FinalEditGroupView, FinalEditVariantView } from '@/lib/final-edit/types';
import type { StyleTarget } from './FinalEditInspector';
import { drawEditorOverlay } from './text-canvas-renderer';
import styles from './FinalEditEditor.module.css';

const FPS = 24;
const INTRO_SEC = 20 / FPS;

function formatTime(timeSec: number) {
  const value = Math.max(0, timeSec);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;
}

export function FinalEditPreview({ group, variant, assets, selectedAsset, playheadSec, textTarget, onPlayheadChange, onTextPositionChange }: {
  group: FinalEditGroupView;
  variant: FinalEditVariantView;
  assets: FinalEditAssetView[];
  selectedAsset: FinalEditAssetView | null;
  playheadSec: number;
  textTarget: StyleTarget | null;
  onPlayheadChange: (timeSec: number) => void;
  onTextPositionChange: (target: StyleTarget, x: number, y: number, commit: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const narrationRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const clockStartRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const animationRef = useRef(0);
  const playingRef = useRef(false);
  const [playing, setPlaying] = useState(false);

  const totalSec = INTRO_SEC + variant.timeline.bodyFrames / FPS;
  const bodyFrame = Math.max(0, Math.floor((playheadSec - INTRO_SEC) * FPS));
  const sortedClips = useMemo(() => [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame), [variant.timeline.clips]);
  const activeClipIndex = playheadSec >= INTRO_SEC ? sortedClips.findIndex((clip) => bodyFrame >= clip.timelineInFrame && bodyFrame < clip.timelineOutFrame) : -1;
  const activeClip = activeClipIndex >= 0 ? sortedClips[activeClipIndex] : null;
  const activeAsset = activeClip ? assets.find((asset) => asset.videoJobId === activeClip.videoJobId) || null : null;
  const nextClip = activeClipIndex >= 0 ? sortedClips[activeClipIndex + 1] || null : sortedClips[0] || null;
  const nextAsset = nextClip ? assets.find((asset) => asset.videoJobId === nextClip.videoJobId) || null : null;
  const activeSlot = activeClipIndex < 0 ? 0 : activeClipIndex % 2;
  const bodyTimeUs = Math.max(0, (playheadSec - INTRO_SEC) * 1_000_000);
  const activeCue = playheadSec >= INTRO_SEC ? group.subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs) || null : null;
  const showSelectedMaterial = !playing && Boolean(selectedAsset);
  const activeFraming = activeClip?.framing || { scale: 1, offsetX: 0, offsetY: 0 };

  useEffect(() => {
    if (canvasRef.current) drawEditorOverlay(canvasRef.current, group, variant.outputPreset, showSelectedMaterial ? null : activeCue, playheadSec < INTRO_SEC && !showSelectedMaterial);
  }, [activeCue, group, playheadSec, showSelectedMaterial, variant.outputPreset]);

  useEffect(() => {
    const current = activeSlot === 0 ? videoARef.current : videoBRef.current;
    const standby = activeSlot === 0 ? videoBRef.current : videoARef.current;
    standby?.pause();
    if (current) {
      if (!activeClip || !activeAsset || showSelectedMaterial) { current.pause(); return; }
      const expected = activeClip.sourceInFrame / FPS + Math.max(0, bodyFrame - activeClip.timelineInFrame) / FPS;
      if (Math.abs(current.currentTime - expected) > 0.16) current.currentTime = expected;
      if (playing) void current.play().catch(() => undefined); else current.pause();
    }
  }, [activeAsset, activeClip, activeSlot, bodyFrame, playing, showSelectedMaterial]);

  useEffect(() => {
    const canvas = foregroundCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    const paint = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const video = activeSlot === 0 ? videoARef.current : videoBRef.current;
      if (variant.outputPreset === '16x9' && activeAsset && video && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const fit = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight) * activeFraming.scale;
        const width = video.videoWidth * fit;
        const height = video.videoHeight * fit;
        const x = (canvas.width - width) / 2 + activeFraming.offsetX * Math.abs(canvas.width - width) / 2;
        const y = (canvas.height - height) / 2 + activeFraming.offsetY * Math.abs(canvas.height - height) / 2;
        context.drawImage(video, x, y, width, height);
      }
    };
    const loop = () => { paint(); frame = requestAnimationFrame(loop); };
    const video = activeSlot === 0 ? videoARef.current : videoBRef.current;
    video?.addEventListener('loadeddata', paint);
    video?.addEventListener('seeked', paint);
    if (playing) loop(); else paint();
    return () => {
      cancelAnimationFrame(frame);
      video?.removeEventListener('loadeddata', paint);
      video?.removeEventListener('seeked', paint);
    };
  }, [activeAsset, activeFraming.offsetX, activeFraming.offsetY, activeFraming.scale, activeSlot, bodyFrame, playing, variant.outputPreset]);

  useEffect(() => {
    if (!playing) return;
    const context = audioContextRef.current;
    if (!context) return;
    const tick = () => {
      const next = clockOffsetRef.current + (context.currentTime - clockStartRef.current);
      if (next >= totalSec) {
        onPlayheadChange(totalSec);
        playingRef.current = false;
        setPlaying(false);
        return;
      }
      if (bgmRef.current) {
        const baseGain = Math.min(1, Math.pow(10, variant.bgm.gainDb / 20));
        const remaining = Math.max(0, totalSec - next);
        bgmRef.current.volume = baseGain * Math.min(1, remaining / Math.max(0.01, variant.bgm.fadeOutSec));
      }
      onPlayheadChange(next);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationRef.current);
  }, [onPlayheadChange, playing, totalSec, variant.bgm.fadeOutSec, variant.bgm.gainDb]);

  useEffect(() => {
    playingRef.current = playing;
    if (playing) return;
    narrationRef.current?.pause();
    bgmRef.current?.pause();
    videoARef.current?.pause();
    videoBRef.current?.pause();
  }, [playing]);

  const syncAudio = (startAt: number) => {
    const bodyOffset = Math.max(0, startAt - INTRO_SEC);
    const delayMs = Math.max(0, (INTRO_SEC - startAt) * 1000);
    window.setTimeout(() => {
      if (!audioContextRef.current || !playingRef.current) return;
      const narration = narrationRef.current;
      const bgm = bgmRef.current;
      if (narration) { narration.currentTime = bodyOffset; void narration.play().catch(() => undefined); }
      if (bgm) {
        bgm.currentTime = bodyOffset % Math.max(0.1, bgm.duration || variant.timeline.bodyFrames / FPS);
        bgm.volume = Math.min(1, Math.pow(10, variant.bgm.gainDb / 20));
        void bgm.play().catch(() => undefined);
      }
    }, delayMs);
  };

  const togglePlayback = async () => {
    if (playing) { playingRef.current = false; setPlaying(false); return; }
    const context = audioContextRef.current || new AudioContext();
    audioContextRef.current = context;
    if (context.state === 'suspended') await context.resume();
    const startAt = playheadSec >= totalSec ? 0 : playheadSec;
    if (startAt !== playheadSec) onPlayheadChange(startAt);
    clockOffsetRef.current = startAt;
    clockStartRef.current = context.currentTime;
    playingRef.current = true;
    setPlaying(true);
    window.setTimeout(() => syncAudio(startAt), 0);
  };

  const seek = (next: number) => {
    playingRef.current = false;
    setPlaying(false);
    onPlayheadChange(Math.max(0, Math.min(totalSec, next)));
  };

  const coverFraming = variant.cover.framing || { scale: 1, offsetX: 0, offsetY: 0 };
  const previewClass = variant.outputPreset === '16x9' ? styles.preview169 : variant.outputPreset === '9x16' ? styles.preview916 : styles.preview34;
  const videoAAsset = activeSlot === 0 ? activeAsset : nextAsset;
  const videoBAsset = activeSlot === 1 ? activeAsset : nextAsset;
  const canDragText = !showSelectedMaterial && Boolean(textTarget) && ((playheadSec < INTRO_SEC && textTarget !== 'subtitle') || (playheadSec >= INTRO_SEC && textTarget === 'subtitle' && activeCue));
  const beginTextDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!textTarget || !canDragText) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    let latest = { x: 0.5, y: 0.5 };
    const move = (pointer: PointerEvent) => {
      latest = { x: Math.max(0, Math.min(1, (pointer.clientX - rect.left) / Math.max(1, rect.width))), y: Math.max(0, Math.min(1, (pointer.clientY - rect.top) / Math.max(1, rect.height))) };
      onTextPositionChange(textTarget, latest.x, latest.y, false);
    };
    const up = (pointer: PointerEvent) => {
      move(pointer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onTextPositionChange(textTarget, latest.x, latest.y, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <main className={styles.previewColumn} aria-label="成片预览">
      <div className={styles.previewToolbar}><span>{variant.outputPreset.replace('x', ':')} · {FPS} fps</span><span>{showSelectedMaterial ? '素材预览' : activeClip ? `片段 ${activeClipIndex + 1}` : playheadSec < INTRO_SEC ? '封面' : '画面缺口'}</span></div>
      <div className={styles.previewStageWrap}>
        <div className={`${styles.previewStage} ${previewClass}`}>
          {showSelectedMaterial && selectedAsset && <img className={`${styles.previewMedia} ${variant.outputPreset === '16x9' ? styles.previewContain : ''}`} src={selectedAsset.thumbnailUrl} alt="当前素材预览" />}
          {!showSelectedMaterial && playheadSec < INTRO_SEC && variant.cover.sourceUrl && <img className={styles.previewMedia} src={variant.cover.sourceUrl} alt="封面预览" style={{ objectPosition: `${50 + coverFraming.offsetX * 50}% ${50 + coverFraming.offsetY * 50}%`, transform: `scale(${coverFraming.scale})` }} />}
          <video ref={videoARef} src={videoAAsset?.previewUrl} className={`${styles.previewMedia} ${variant.outputPreset === '16x9' ? styles.previewBlurred : ''} ${showSelectedMaterial || !activeAsset || activeSlot !== 0 ? styles.previewInactive : ''}`} muted playsInline preload="auto" style={variant.outputPreset === '16x9' ? undefined : { objectPosition: `${50 + activeFraming.offsetX * 50}% ${50 + activeFraming.offsetY * 50}%`, transform: `scale(${activeFraming.scale})` }} />
          <video ref={videoBRef} src={videoBAsset?.previewUrl} className={`${styles.previewMedia} ${variant.outputPreset === '16x9' ? styles.previewBlurred : ''} ${showSelectedMaterial || !activeAsset || activeSlot !== 1 ? styles.previewInactive : ''}`} muted playsInline preload="auto" style={variant.outputPreset === '16x9' ? undefined : { objectPosition: `${50 + activeFraming.offsetX * 50}% ${50 + activeFraming.offsetY * 50}%`, transform: `scale(${activeFraming.scale})` }} />
          <canvas ref={foregroundCanvasRef} width={1920} height={1080} className={`${styles.previewMedia} ${variant.outputPreset === '16x9' ? '' : styles.previewInactive}`} />
          {!showSelectedMaterial && playheadSec >= INTRO_SEC && !activeAsset && <div className={styles.previewGap}><strong>这里没有画面</strong><small>把左侧素材拖到视频轨，或使用 AI 补齐缺口</small></div>}
          <canvas ref={canvasRef} className={`${styles.previewCanvas} ${canDragText ? styles.draggableOverlay : ''}`} onPointerDown={beginTextDrag} />
          <span className={styles.previewBadge}>{showSelectedMaterial ? '选中素材' : '成片时间线'}</span>
        </div>
      </div>
      <div className={styles.playbackBar}>
        <button type="button" className={styles.playButton} aria-label={playing ? '暂停' : '播放成片'} onClick={() => void togglePlayback()}>{playing ? 'Ⅱ' : '▶'}</button>
        <span className={styles.timecode}>{formatTime(playheadSec)} / {formatTime(totalSec)}</span>
        <input aria-label="播放位置" type="range" min={0} max={totalSec} step={1 / FPS} value={playheadSec} onChange={(event) => seek(Number(event.target.value))} />
      </div>
      <audio ref={narrationRef} preload="metadata" src={`/api/final-edit-groups/${group.id}/narration`} />
      {variant.bgm.trackId && <audio ref={bgmRef} preload="metadata" loop src={`/api/final-edit-bgm/${variant.bgm.trackId}/file`} />}
    </main>
  );
}
