'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawFramedImage } from '@/lib/final-edit/cover-framing';
import { OUTPUT_PRESETS, type FinalEditAssetView, type FinalEditGroupView, type FinalEditVariantView } from '@/lib/final-edit/types';
import type { StyleTarget } from './FinalEditInspector';
import { expectedVideoTimeSec, getVideoSlotPlan, paintDecodedVideoFrame, previewAudioLevelsAtTime } from './preview-playback';
import { drawEditorOverlay, textStyleFont } from './text-canvas-renderer';
import styles from './FinalEditEditor.module.css';

const FPS = 24;
const INTRO_SEC = 20 / FPS;

function formatTime(timeSec: number) {
  const value = Math.max(0, timeSec);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`;
}

interface PreviewAudioGraph {
  context: AudioContext;
  narrationGain: GainNode;
  bgmGain: GainNode;
}

function seekMedia(element: HTMLMediaElement | null, timeSec: number) {
  if (!element || !Number.isFinite(timeSec)) return;
  if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
    element.addEventListener('loadedmetadata', () => seekMedia(element, timeSec), { once: true });
    return;
  }
  try {
    element.currentTime = Math.max(0, timeSec);
  } catch {
    // A media source can disappear while switching groups; the next prop sync retries.
  }
}

export function FinalEditPreview({ group, variant, assets, selectedAsset, playheadSec, seekRequestId, active = true, textTarget, onPlayheadChange, onTextPositionChange }: {
  group: FinalEditGroupView;
  variant: FinalEditVariantView;
  assets: FinalEditAssetView[];
  selectedAsset: FinalEditAssetView | null;
  playheadSec: number;
  seekRequestId?: string | number;
  active?: boolean;
  textTarget: StyleTarget | null;
  onPlayheadChange: (timeSec: number) => void;
  onTextPositionChange: (target: StyleTarget, x: number, y: number, commit: boolean) => void;
}) {
  const previewRootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coverImageCanvasRef = useRef<HTMLCanvasElement>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const narrationRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGraphRef = useRef<PreviewAudioGraph | null>(null);
  const clockStartRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const animationRef = useRef(0);
  const audioStartTimerRef = useRef(0);
  const playingRef = useRef(false);
  const lastStartedClipRef = useRef('');
  const emittedPlayheadsRef = useRef<number[]>([]);
  const lastSeekRequestIdRef = useRef<string | number | undefined>(seekRequestId);
  const playheadSecRef = useRef(playheadSec);
  const [playing, setPlaying] = useState(false);
  const [showSafeArea, setShowSafeArea] = useState(false);

  useEffect(() => { playheadSecRef.current = playheadSec; }, [playheadSec]);

  const narrationPlaybackRate = group.script.narrationConfig.playbackRate;
  const bodyDurationSec = group.narrationDurationUs / 1_000_000 / narrationPlaybackRate;
  const totalSec = INTRO_SEC + bodyDurationSec;
  const rawBodyFrame = Math.max(0, Math.floor((playheadSec - INTRO_SEC) * FPS));
  const sortedClips = useMemo(() => [...variant.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame), [variant.timeline.clips]);
  const frozenVideoTail = rawBodyFrame >= variant.timeline.bodyFrames && sortedClips.length > 0;
  const bodyFrame = frozenVideoTail
    ? Math.max(0, sortedClips[sortedClips.length - 1].timelineOutFrame - 1)
    : rawBodyFrame;
  const activeClipIndex = playheadSec >= INTRO_SEC
    ? frozenVideoTail ? sortedClips.length - 1 : sortedClips.findIndex((clip) => bodyFrame >= clip.timelineInFrame && bodyFrame < clip.timelineOutFrame)
    : -1;
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
  const bodyTimeUs = Math.max(0, (playheadSec - INTRO_SEC) * 1_000_000 * narrationPlaybackRate);
  const activeCue = playheadSec >= INTRO_SEC ? group.subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs) || null : null;
  const showSelectedMaterial = !playing && Boolean(selectedAsset);
  const activeFraming = activeClip?.framing || { scale: 1, offsetX: 0, offsetY: 0 };
  const activeFramingScale = activeFraming.scale;
  const activeFramingOffsetX = activeFraming.offsetX;
  const activeFramingOffsetY = activeFraming.offsetY;
  const previewSize = OUTPUT_PRESETS[variant.outputPreset];

  const setAudioLevels = useCallback((timeSec: number) => {
    const graph = audioGraphRef.current;
    if (!graph) return;
    const levels = previewAudioLevelsAtTime({
      playheadSec: timeSec,
      introSec: INTRO_SEC,
      bodyDurationSec,
      gainDb: variant.bgm.gainDb,
      fadeInSec: variant.bgm.fadeInSec,
      fadeOutSec: variant.bgm.fadeOutSec,
    });
    graph.narrationGain.gain.setValueAtTime(levels.narrationGain, graph.context.currentTime);
    graph.bgmGain.gain.setValueAtTime(levels.bgmGain, graph.context.currentTime);
  }, [bodyDurationSec, variant.bgm.fadeInSec, variant.bgm.fadeOutSec, variant.bgm.gainDb]);

  const pauseAllMedia = useCallback(() => {
    playingRef.current = false;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = 0;
    if (audioStartTimerRef.current) window.clearTimeout(audioStartTimerRef.current);
    audioStartTimerRef.current = 0;
    videoARef.current?.pause();
    videoBRef.current?.pause();
    narrationRef.current?.pause();
    bgmRef.current?.pause();
    const graph = audioGraphRef.current;
    if (graph) {
      graph.narrationGain.gain.setValueAtTime(0, graph.context.currentTime);
      graph.bgmGain.gain.setValueAtTime(0, graph.context.currentTime);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    pauseAllMedia();
    setPlaying(false);
  }, [pauseAllMedia]);

  const emitPlayhead = useCallback((timeSec: number) => {
    emittedPlayheadsRef.current.push(timeSec);
    if (emittedPlayheadsRef.current.length > 8) emittedPlayheadsRef.current.shift();
    onPlayheadChange(timeSec);
  }, [onPlayheadChange]);

  const synchronizePausedAudio = useCallback((timeSec: number) => {
    const bodyOffset = Math.max(0, Math.min(bodyDurationSec, timeSec - INTRO_SEC));
    seekMedia(narrationRef.current, bodyOffset * narrationPlaybackRate);
    const bgm = bgmRef.current;
    if (bgm) {
      const loopDuration = Number.isFinite(bgm.duration) && bgm.duration > 0 ? bgm.duration : bodyDurationSec;
      seekMedia(bgm, bodyOffset % Math.max(0.1, loopDuration));
    }
  }, [bodyDurationSec, narrationPlaybackRate]);

  useEffect(() => {
    const narration = narrationRef.current;
    if (!narration) return;
    narration.defaultPlaybackRate = narrationPlaybackRate;
    narration.playbackRate = narrationPlaybackRate;
    narration.preservesPitch = true;
    const bodyOffset = Math.max(0, Math.min(bodyDurationSec, playheadSecRef.current - INTRO_SEC));
    seekMedia(narration, bodyOffset * narrationPlaybackRate);
  }, [bodyDurationSec, narrationPlaybackRate]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const showTitle = playheadSec < INTRO_SEC && !showSelectedMaterial;
    const cue = showSelectedMaterial ? null : activeCue;
    const styles = group.textStyles[variant.outputPreset];
    const fonts = showTitle
      ? [[styles.coverPrimary, group.coverTitle.primary.text], [styles.coverSecondary, group.coverTitle.secondary.text]] as const
      : cue ? [[styles.subtitle, cue.text]] as const : [];
    let cancelled = false;
    void Promise.all(fonts.map(([style, text]) => document.fonts.load(textStyleFont(style), text)))
      .catch(() => undefined)
      .then(() => { if (!cancelled) drawEditorOverlay(canvas, group, variant.outputPreset, cue, showTitle); });
    return () => { cancelled = true; };
  }, [activeCue, group, playheadSec, showSelectedMaterial, variant.outputPreset]);

  useEffect(() => {
    const canvas = coverImageCanvasRef.current;
    if (!canvas) return;
    canvas.width = previewSize.width;
    canvas.height = previewSize.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!variant.cover.sourceUrl) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) drawFramedImage(context, image, variant.cover.framing);
    };
    image.src = variant.cover.sourceUrl;
    return () => { cancelled = true; };
  }, [previewSize.height, previewSize.width, variant.cover.framing, variant.cover.sourceUrl]);

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
        if (frozenVideoTail) {
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
  }, [activeAsset, activeClip, activeSlot, bodyFrame, frozenVideoTail, playing, showSelectedMaterial, slotAClipId, slotASourceInFrame, slotBClipId, slotBSourceInFrame, slotClips]);

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
        emitPlayhead(totalSec);
        stopPlayback();
        return;
      }
      setAudioLevels(next);
      emitPlayhead(next);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationRef.current);
  }, [emitPlayhead, playing, setAudioLevels, stopPlayback, totalSec]);

  useEffect(() => {
    playingRef.current = playing;
    if (playing) return;
    pauseAllMedia();
  }, [pauseAllMedia, playing]);

  useEffect(() => {
    if (active) return;
    pauseAllMedia();
    const timer = window.setTimeout(() => setPlaying(false), 0);
    return () => window.clearTimeout(timer);
  }, [active, pauseAllMedia]);

  useEffect(() => () => {
    pauseAllMedia();
    const context = audioContextRef.current;
    audioGraphRef.current = null;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
  }, [pauseAllMedia]);

  useEffect(() => {
    const requestChanged = seekRequestId !== undefined && seekRequestId !== lastSeekRequestIdRef.current;
    lastSeekRequestIdRef.current = seekRequestId;
    const emittedIndex = emittedPlayheadsRef.current.findIndex((value) => Math.abs(value - playheadSec) < 1e-6);
    const internallyEmitted = emittedIndex >= 0;
    if (internallyEmitted) emittedPlayheadsRef.current.splice(0, emittedIndex + 1);
    else emittedPlayheadsRef.current = [];
    if (internallyEmitted && !requestChanged) return;
    stopPlayback();
    synchronizePausedAudio(playheadSec);
  }, [playheadSec, seekRequestId, stopPlayback, synchronizePausedAudio, variant.id]);

  const syncAudio = (startAt: number) => {
    const bodyOffset = Math.max(0, startAt - INTRO_SEC);
    const delayMs = Math.max(0, (INTRO_SEC - startAt) * 1000);
    if (audioStartTimerRef.current) window.clearTimeout(audioStartTimerRef.current);
    audioStartTimerRef.current = window.setTimeout(() => {
      audioStartTimerRef.current = 0;
      if (!audioContextRef.current || !playingRef.current) return;
      const narration = narrationRef.current;
      const bgm = bgmRef.current;
      if (narration) {
        narration.volume = 1;
        seekMedia(narration, bodyOffset * narrationPlaybackRate);
        void narration.play().catch(() => undefined);
      }
      if (bgm && variant.bgm.trackId) {
        const loopDuration = Number.isFinite(bgm.duration) && bgm.duration > 0 ? bgm.duration : bodyDurationSec;
        bgm.volume = 1;
        seekMedia(bgm, bodyOffset % Math.max(0.1, loopDuration));
        void bgm.play().catch(() => undefined);
      }
    }, delayMs);
  };

  const ensureAudioGraph = () => {
    if (audioGraphRef.current) return audioGraphRef.current;
    const narration = narrationRef.current;
    const bgm = bgmRef.current;
    if (!narration || !bgm) return null;
    const context = audioContextRef.current || new AudioContext();
    audioContextRef.current = context;
    const narrationGain = context.createGain();
    const bgmGain = context.createGain();
    context.createMediaElementSource(narration).connect(narrationGain).connect(context.destination);
    context.createMediaElementSource(bgm).connect(bgmGain).connect(context.destination);
    const graph = { context, narrationGain, bgmGain };
    audioGraphRef.current = graph;
    return graph;
  };

  const togglePlayback = async () => {
    if (!active) return;
    if (playing) { stopPlayback(); return; }
    const graph = ensureAudioGraph();
    if (!graph) return;
    const { context } = graph;
    if (context.state === 'suspended') await context.resume();
    const startAt = playheadSec >= totalSec ? 0 : playheadSec;
    if (startAt !== playheadSec) emitPlayhead(startAt);
    clockOffsetRef.current = startAt;
    clockStartRef.current = context.currentTime;
    setAudioLevels(startAt);
    playingRef.current = true;
    setPlaying(true);
    syncAudio(startAt);
  };

  const seek = (next: number) => {
    const clamped = Math.max(0, Math.min(totalSec, next));
    stopPlayback();
    synchronizePausedAudio(clamped);
    emitPlayhead(clamped);
  };

  const enterFullscreen = async () => {
    const root = previewRootRef.current;
    if (!root || document.fullscreenElement === root) return;
    await root.requestFullscreen().catch(() => undefined);
  };

  const previewClass = variant.outputPreset === '16x9' ? styles.preview169 : variant.outputPreset === '9x16' ? styles.preview916 : styles.preview34;
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
    <main ref={previewRootRef} className={styles.previewColumn} aria-label="成片预览">
      <div className={styles.previewToolbar}><span>{variant.outputPreset.replace('x', ':')} · {FPS} fps</span><span>{showSelectedMaterial ? '素材预览' : activeClip ? `片段 ${activeClipIndex + 1}` : playheadSec < INTRO_SEC ? '封面' : '画面缺口'}</span></div>
      <div className={styles.previewStageWrap}>
        <div className={`${styles.previewStage} ${previewClass}`}>
          {showSelectedMaterial && selectedAsset && <img className={`${styles.previewMedia} ${variant.outputPreset === '16x9' ? styles.previewContain : ''}`} src={selectedAsset.thumbnailUrl} alt="当前素材预览" />}
          <canvas ref={coverImageCanvasRef} width={previewSize.width} height={previewSize.height} className={`${styles.previewMedia} ${showSelectedMaterial || playheadSec >= INTRO_SEC || !variant.cover.sourceUrl ? styles.previewInactive : ''}`} aria-label="封面预览" />
          <video ref={videoARef} src={videoAAsset?.previewUrl} className={`${styles.previewMedia} ${styles.previewInactive}`} muted playsInline preload="auto" aria-hidden="true" />
          <video ref={videoBRef} src={videoBAsset?.previewUrl} className={`${styles.previewMedia} ${styles.previewInactive}`} muted playsInline preload="auto" aria-hidden="true" />
          <canvas ref={foregroundCanvasRef} width={previewSize.width} height={previewSize.height} className={`${styles.previewMedia} ${showSelectedMaterial || playheadSec < INTRO_SEC || !activeAsset ? styles.previewInactive : ''}`} />
          {!showSelectedMaterial && playheadSec >= INTRO_SEC && !activeAsset && <div className={styles.previewGap}><strong>这里没有画面</strong><small>把左侧素材拖到视频轨，或使用 AI 补齐缺口</small></div>}
          <canvas ref={canvasRef} className={`${styles.previewCanvas} ${canDragText ? styles.draggableOverlay : ''}`} onPointerDown={beginTextDrag} />
          {showSafeArea && <div className={styles.previewSafeArea} aria-label="4% 预览安全区" />}
          <span className={styles.previewBadge}>{showSelectedMaterial ? '选中素材' : '成片时间线'}</span>
        </div>
      </div>
      <div className={styles.playbackBar}>
        <button type="button" className={styles.playButton} aria-label={playing ? '暂停' : '播放成片'} onClick={() => void togglePlayback()}>{playing ? 'Ⅱ' : '▶'}</button>
        <span className={styles.timecode}>{formatTime(playheadSec)} / {formatTime(totalSec)}</span>
        <input aria-label="播放位置" type="range" min={0} max={totalSec} step={1 / FPS} value={playheadSec} onChange={(event) => seek(Number(event.target.value))} />
        <button
          type="button"
          className={`${styles.actionButton} ${showSafeArea ? styles.safeAreaButtonActive : ''}`}
          aria-label={showSafeArea ? '隐藏安全区' : '显示安全区'}
          aria-pressed={showSafeArea}
          onClick={() => setShowSafeArea((visible) => !visible)}
        >安全区</button>
        <button type="button" className={styles.actionButton} aria-label="全屏预览" onClick={() => void enterFullscreen()}>全屏</button>
      </div>
      <audio ref={narrationRef} preload="metadata" src={`/api/final-edit-groups/${group.id}/narration`} />
      <audio ref={bgmRef} preload="metadata" loop src={variant.bgm.trackId ? `/api/final-edit-bgm/${variant.bgm.trackId}/file` : undefined} />
    </main>
  );
}
