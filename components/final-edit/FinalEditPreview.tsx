'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FinalEditAssetView, FinalEditGroupView, FinalEditVariantView } from '@/lib/final-edit/types';
import type { StyleTarget } from './FinalEditInspector';
import { expectedVideoTimeSec, getVideoSlotPlan, paintDecodedVideoFrame } from './preview-playback';
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
  const lastStartedClipRef = useRef('');
  const [playing, setPlaying] = useState(false);

  const totalSec = INTRO_SEC + variant.timeline.bodyFrames / FPS;
  const bodyFrame = Math.max(0, Math.floor((playheadSec - INTRO_SEC) * FPS));
  const sortedClips = useMemo(() => [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame), [variant.timeline.clips]);
  const activeClipIndex = playheadSec >= INTRO_SEC ? sortedClips.findIndex((clip) => bodyFrame >= clip.timelineInFrame && bodyFrame < clip.timelineOutFrame) : -1;
  const activeClip = activeClipIndex >= 0 ? sortedClips[activeClipIndex] : null;
  const activeAsset = activeClip ? assets.find((asset) => asset.videoJobId === activeClip.videoJobId) || null : null;
  const slotPlan = getVideoSlotPlan(activeClipIndex, sortedClips.length);
  const slotClips = slotPlan.clipIndexes.map((index) => index == null ? null : sortedClips[index]) as [typeof activeClip, typeof activeClip];
  const slotAssets = slotClips.map((clip) => clip ? assets.find((asset) => asset.videoJobId === clip.videoJobId) || null : null) as [FinalEditAssetView | null, FinalEditAssetView | null];
  const activeSlot = slotPlan.activeSlot;
  const slotAClipId = slotClips[0]?.id || '';
  const slotASourceInFrame = slotClips[0]?.sourceInFrame ?? -1;
  const slotBClipId = slotClips[1]?.id || '';
  const slotBSourceInFrame = slotClips[1]?.sourceInFrame ?? -1;
  const bodyTimeUs = Math.max(0, (playheadSec - INTRO_SEC) * 1_000_000);
  const activeCue = playheadSec >= INTRO_SEC ? group.subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs) || null : null;
  const showSelectedMaterial = !playing && Boolean(selectedAsset);
  const activeFraming = activeClip?.framing || { scale: 1, offsetX: 0, offsetY: 0 };
  const activeFramingScale = activeFraming.scale;
  const activeFramingOffsetX = activeFraming.offsetX;
  const activeFramingOffsetY = activeFraming.offsetY;

  useEffect(() => {
    if (canvasRef.current) drawEditorOverlay(canvasRef.current, group, variant.outputPreset, showSelectedMaterial ? null : activeCue, playheadSec < INTRO_SEC && !showSelectedMaterial);
  }, [activeCue, group, playheadSec, showSelectedMaterial, variant.outputPreset]);

  useEffect(() => {
    const videos = [videoARef.current, videoBRef.current] as const;
    const cleanups: Array<() => void> = [];
    videos.forEach((video, slot) => {
      const clip = slotClips[slot];
      if (!video || !clip) return;
      const expected = slot === activeSlot
        ? expectedVideoTimeSec(clip.sourceInFrame, clip.timelineInFrame, bodyFrame, FPS)
        : clip.sourceInFrame / FPS;
      const synchronize = () => {
        if (slot !== activeSlot) {
          video.pause();
          if (Math.abs(video.currentTime - expected) > 1 / FPS) video.currentTime = expected;
          return;
        }
        if (!activeAsset || showSelectedMaterial) { video.pause(); return; }
        if (!playing) {
          lastStartedClipRef.current = '';
          video.pause();
          if (Math.abs(video.currentTime - expected) > 1 / FPS) video.currentTime = expected;
          return;
        }
        if (lastStartedClipRef.current === clip.id) return;
        if (Math.abs(video.currentTime - expected) > 0.35) video.currentTime = expected;
        lastStartedClipRef.current = clip.id;
        void video.play().catch(() => undefined);
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) synchronize();
      else {
        video.addEventListener('loadedmetadata', synchronize, { once: true });
        cleanups.push(() => video.removeEventListener('loadedmetadata', synchronize));
      }
    });
    if (activeSlot == null || !activeClip || !activeAsset || showSelectedMaterial) {
      lastStartedClipRef.current = '';
      videoARef.current?.pause();
      videoBRef.current?.pause();
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [activeAsset, activeClip, activeSlot, bodyFrame, playing, showSelectedMaterial, slotAClipId, slotASourceInFrame, slotBClipId, slotBSourceInFrame, slotClips]);

  useEffect(() => {
    const canvas = foregroundCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    const paint = () => {
      const video = activeSlot === 0 ? videoARef.current : activeSlot === 1 ? videoBRef.current : null;
      if (activeAsset && video) paintDecodedVideoFrame(context, canvas, video, variant.outputPreset, {
        scale: activeFramingScale,
        offsetX: activeFramingOffsetX,
        offsetY: activeFramingOffsetY,
      });
    };
    const loop = () => { paint(); frame = requestAnimationFrame(loop); };
    const video = activeSlot === 0 ? videoARef.current : activeSlot === 1 ? videoBRef.current : null;
    video?.addEventListener('loadeddata', paint);
    video?.addEventListener('seeked', paint);
    if (playing) loop(); else paint();
    return () => {
      cancelAnimationFrame(frame);
      video?.removeEventListener('loadeddata', paint);
      video?.removeEventListener('seeked', paint);
    };
  }, [activeAsset, activeFramingOffsetX, activeFramingOffsetY, activeFramingScale, activeSlot, bodyFrame, playing, variant.outputPreset]);

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
  const previewSize = variant.outputPreset === '16x9' ? { width: 1920, height: 1080 } : variant.outputPreset === '9x16' ? { width: 1080, height: 1920 } : { width: 1080, height: 1440 };
  const videoAAsset = slotAssets[0];
  const videoBAsset = slotAssets[1];
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
          <video ref={videoARef} src={videoAAsset?.previewUrl} className={`${styles.previewMedia} ${styles.previewInactive}`} muted playsInline preload="auto" aria-hidden="true" />
          <video ref={videoBRef} src={videoBAsset?.previewUrl} className={`${styles.previewMedia} ${styles.previewInactive}`} muted playsInline preload="auto" aria-hidden="true" />
          <canvas ref={foregroundCanvasRef} width={previewSize.width} height={previewSize.height} className={`${styles.previewMedia} ${showSelectedMaterial || playheadSec < INTRO_SEC || !activeAsset ? styles.previewInactive : ''}`} />
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
