'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  expectedVideoTimeSec,
  getVideoSlotPlan,
  paintDecodedVideoFrame,
  previewAudioLevelsAtTime,
  shouldIssueSeek,
} from '@/components/final-edit/preview-playback';
import {
  FINAL_EDIT_FPS,
  FINAL_EDIT_INTRO_FRAMES,
  OUTPUT_PRESETS,
  type OutputPresetId,
} from '@/lib/final-edit/types';
import { defaultTextStyle } from '@/lib/media-core/cover-domain';
import { textStyleToSvgElements } from '@/lib/media-core/cover-title-svg';
import type { TextStyle } from '@/lib/media-core/cover-types';
import styles from './batch-preview.module.css';

const FPS = FINAL_EDIT_FPS;
const INTRO_SEC = FINAL_EDIT_INTRO_FRAMES / FPS; // 20/24 秒片头封面静帧

export interface BatchTimelinePreviewClip {
  clipId: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
}

export interface BatchTimelinePreviewProps {
  clips: BatchTimelinePreviewClip[];
  /** assetId → 代理预览地址（LUT 已烧入，色彩与正式渲染一致） */
  assetsById: Record<string, { previewUrl: string }>;
  coverUrl: string | null;
  subtitleCues: Array<{ id?: string; startUs: number; endUs: number; text: string }>;
  subtitleStyle?: TextStyle;
  narrationUrl: string | null;
  bgm: { fileUrl: string; gainDb: number; fadeInSec: number; fadeOutSec: number } | null;
  outputPreset: OutputPresetId;
  /** 含片头的绝对播放头（受控，与时间轴共享） */
  playheadSec: number;
  onSeek: (sec: number) => void;
  /** false 时暂停一切播放（预留防御；当前调用方未传，弹窗关闭靠卸载兜底） */
  active?: boolean;
  /** 嵌入编辑器时让预览区与时间轴共享固定高度，避免预览把时间轴推到视口外。 */
  compact?: boolean;
}

function formatTime(timeSec: number): string {
  const value = Math.max(0, timeSec);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`;
}

function usToFrame(us: number): number {
  return Math.round((us / 1_000_000) * FPS);
}

function seekMedia(element: HTMLMediaElement | null, timeSec: number): void {
  if (!element || !Number.isFinite(timeSec)) return;
  if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
    element.addEventListener('loadedmetadata', () => seekMedia(element, timeSec), { once: true });
    return;
  }
  try {
    element.currentTime = Math.max(0, timeSec);
  } catch {
    // 媒体源切换瞬间 currentTime 可能不可写,下一轮同步会补上。
  }
}

/**
 * 批量「检查成片」的实时预览:客户端按当前 arrangement 即时合成,不等重渲染。
 * 机制与单条混剪预览同源——片头封面静帧、双 <video> slot 轮播、前景 canvas 上屏、
 * 字幕顶层 SVG、口播片头结束后起播、BGM 音量包络;但不依赖 final-edit 的路由与类型。
 */
export default function BatchTimelinePreview({
  clips,
  assetsById,
  coverUrl,
  subtitleCues,
  subtitleStyle,
  narrationUrl,
  bgm,
  outputPreset,
  playheadSec,
  onSeek,
  active = true,
  compact = false,
}: BatchTimelinePreviewProps) {
  const sortedClips = useMemo(() => [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs), [clips]);
  const bodyDurationSec = (sortedClips.at(-1)?.timelineEndUs ?? 0) / 1_000_000;
  const totalSec = INTRO_SEC + bodyDurationSec;
  const size = OUTPUT_PRESETS[outputPreset];

  const [playing, setPlaying] = useState(false);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const narrationRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const playingRef = useRef(false);
  const clockStartRef = useRef(0);
  const clockOffsetRef = useRef(0);
  const animationRef = useRef(0);
  const audioStartTimerRef = useRef(0);
  const lastStartedClipRef = useRef('');
  const lastDrivenSecRef = useRef(0);
  const externalSeekUntilRef = useRef(0);
  /** seek 合流:两 slot 各自的最新 seek 目标;seek 在途时只记录不写入,seeked 后补齐最新目标。 */
  const seekTargetRef = useRef<[number | null, number | null]>([null, null]);
  const drivePlayhead = useCallback((sec: number) => {
    lastDrivenSecRef.current = sec;
    onSeek(sec);
  }, [onSeek]);

  const bodyFrames = Math.max(0, usToFrame(sortedClips.at(-1)?.timelineEndUs ?? 0));
  const rawBodyFrame = Math.max(0, Math.floor((playheadSec - INTRO_SEC) * FPS));
  const frozenVideoTail = rawBodyFrame >= bodyFrames && sortedClips.length > 0;
  const bodyFrame = frozenVideoTail ? Math.max(0, bodyFrames - 1) : rawBodyFrame;
  const activeClipIndex = playheadSec >= INTRO_SEC
    ? frozenVideoTail
      ? sortedClips.length - 1
      : sortedClips.findIndex((clip) => bodyFrame >= usToFrame(clip.timelineStartUs) && bodyFrame < usToFrame(clip.timelineEndUs))
    : -1;
  const activeClip = activeClipIndex >= 0 ? sortedClips[activeClipIndex] : null;
  const slotPlan = getVideoSlotPlan(activeClipIndex, sortedClips.length);
  const slotIndexA = slotPlan.clipIndexes[0];
  const slotIndexB = slotPlan.clipIndexes[1];
  const slotClips = useMemo(
    () => [
      slotIndexA == null ? null : sortedClips[slotIndexA],
      slotIndexB == null ? null : sortedClips[slotIndexB],
    ] as [BatchTimelinePreviewClip | null, BatchTimelinePreviewClip | null],
    [slotIndexA, slotIndexB, sortedClips],
  );
  const activeSlot = slotPlan.activeSlot;
  const bodyTimeUs = Math.max(0, (playheadSec - INTRO_SEC) * 1_000_000);
  const activeCue = playheadSec >= INTRO_SEC
    ? subtitleCues.find((cue) => bodyTimeUs >= cue.startUs && bodyTimeUs < cue.endUs) ?? null
    : null;
  // 时间轴也能从外部直接 seek；封面/成片状态以实际播放头为准，避免外部
  // seek 到 0 时仍残留「成片」模式而显示黑帧。
  const previewMode: 'cover' | 'finished' = playheadSec < INTRO_SEC ? 'cover' : 'finished';
  const showCover = playheadSec < INTRO_SEC;
  const resolvedSubtitleStyle = subtitleStyle ?? defaultTextStyle('subtitle', size.width);
  const subtitleSvg = !showCover && activeCue
    ? textStyleToSvgElements(resolvedSubtitleStyle, activeCue.text, size)
    : '';

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
  }, []);

  const stopPlayback = useCallback(() => {
    pauseAllMedia();
    setPlaying(false);
  }, [pauseAllMedia]);

  // 常驻 seeked 监听:seek 在途期间被跳过的最新目标,在 seeked 后补一次赋值,实现「最新目标获胜」。
  useEffect(() => {
    const videos = [videoARef.current, videoBRef.current] as const;
    const listeners = videos.map((video, slot) => {
      const onSeeked = () => {
        const target = seekTargetRef.current[slot];
        if (target == null || !video) return;
        if (shouldIssueSeek(video, target, 1 / FPS)) {
          try {
            video.currentTime = target;
          } catch {
            // 媒体源切换瞬间 currentTime 可能不可写,下一轮同步会补上。
          }
        }
      };
      video?.addEventListener('seeked', onSeeked);
      return () => video?.removeEventListener('seeked', onSeeked);
    });
    return () => listeners.forEach((cleanup) => cleanup());
  }, []);

  // 双 slot 同步:活跃 slot 按源区间期望时间播放,备用 slot 预停在自身入点。
  // seek 写入经 shouldIssueSeek 合流:在途 seek 期间只更新 seekTargetRef,不打断在途 seek。
  useEffect(() => {
    const videos = [videoARef.current, videoBRef.current] as const;
    const cleanups: Array<() => void> = [];
    videos.forEach((video, slot) => {
      const clip = slotClips[slot];
      if (!video || !clip) return;
      const sourceInFrame = usToFrame(clip.sourceStartUs);
      const expected = slot === activeSlot
        ? expectedVideoTimeSec(sourceInFrame, usToFrame(clip.timelineStartUs), bodyFrame, FPS)
        : sourceInFrame / FPS;
      const synchronize = () => {
        seekTargetRef.current[slot] = expected;
        if (slot !== activeSlot || frozenVideoTail || !playing) {
          video.pause();
          if (shouldIssueSeek(video, expected, 1 / FPS)) video.currentTime = expected;
          if (!playing) lastStartedClipRef.current = '';
          return;
        }
        if (lastStartedClipRef.current === clip.clipId) return;
        if (Math.abs(video.currentTime - expected) > 0.35) video.currentTime = expected;
        lastStartedClipRef.current = clip.clipId;
        void video.play().catch(() => undefined);
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) synchronize();
      else {
        video.addEventListener('loadedmetadata', synchronize, { once: true });
        cleanups.push(() => video.removeEventListener('loadedmetadata', synchronize));
      }
    });
    if (activeSlot == null || !activeClip) {
      lastStartedClipRef.current = '';
      videoARef.current?.pause();
      videoBRef.current?.pause();
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [activeClip, activeSlot, bodyFrame, frozenVideoTail, playing, slotClips]);

  // 帧上屏:优先 requestVideoFrameCallback——只在解码器提交新帧时画(24fps 源从 60Hz rAF 降到 24 次/秒),
  // 且暂停态 seek 完成时也会触发,拖动进度条画面能持续跟随。回退到 rAF 循环 + seeked/loadeddata 补帧。
  useEffect(() => {
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let frame = 0;
    let videoFrameHandle = 0;
    let videoFrameActive = false;
    const paint = () => {
      const video = activeSlot === 0 ? videoARef.current : activeSlot === 1 ? videoBRef.current : null;
      if (activeClip && video) {
        paintDecodedVideoFrame(context, canvas, video, outputPreset, { scale: 1, offsetX: 0, offsetY: 0 });
      } else {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    const loop = () => { paint(); frame = requestAnimationFrame(loop); };
    const video = activeSlot === 0 ? videoARef.current : activeSlot === 1 ? videoBRef.current : null;
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      videoFrameActive = true;
      const scheduleVideoFrame = () => {
        videoFrameHandle = video.requestVideoFrameCallback(() => {
          paint();
          // 播放中持续排下一帧;暂停/seek 态画完即止,新帧提交时自然再触发。
          if (playing) scheduleVideoFrame();
        });
      };
      scheduleVideoFrame();
    }
    video?.addEventListener('loadeddata', paint);
    video?.addEventListener('seeked', paint);
    if (playing) loop(); else paint();
    return () => {
      cancelAnimationFrame(frame);
      if (videoFrameActive) video?.cancelVideoFrameCallback(videoFrameHandle);
      video?.removeEventListener('loadeddata', paint);
      video?.removeEventListener('seeked', paint);
    };
  }, [activeClip, activeSlot, bodyFrame, outputPreset, playing]);

  // 播放时钟:performance.now() 推进播放头,同时驱动口播/BGM 音量包络。
  const bgmGainDb = bgm?.gainDb ?? 0;
  const bgmFadeInSec = bgm?.fadeInSec ?? 0;
  const bgmFadeOutSec = bgm?.fadeOutSec ?? 0;
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const next = clockOffsetRef.current + (performance.now() - clockStartRef.current) / 1000;
      if (next >= totalSec) {
        drivePlayhead(totalSec);
        stopPlayback();
        return;
      }
      const levels = previewAudioLevelsAtTime({
        playheadSec: next,
        introSec: INTRO_SEC,
        bodyDurationSec,
        gainDb: bgmGainDb,
        fadeInSec: bgmFadeInSec,
        fadeOutSec: bgmFadeOutSec,
      });
      const narration = narrationRef.current;
      if (narration) narration.volume = narrationUrl ? levels.narrationGain : 0;
      const bgmElement = bgmRef.current;
      if (bgmElement) bgmElement.volume = bgm ? levels.bgmGain : 0;
      // 外部 seek 落地窗口内只续排 rAF 不驱动播放头,等同步 effect 重置时钟基线后再从新基线继续。
      if (performance.now() < externalSeekUntilRef.current) {
        // 空转期间冻结时钟基线,窗口结束后从 seek 值平滑续播,消除 ~120ms 补跳。
        clockStartRef.current = performance.now();
        animationRef.current = requestAnimationFrame(tick);
        return;
      }
      drivePlayhead(next);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationRef.current);
  }, [bgm, bgmFadeInSec, bgmFadeOutSec, bgmGainDb, bodyDurationSec, drivePlayhead, narrationUrl, playing, stopPlayback, totalSec]);

  useEffect(() => {
    if (active) return;
    pauseAllMedia();
    // setPlaying 异步置位:effect 里同步 setState 会触发级联渲染(lint 红线)。
    const timer = window.setTimeout(() => setPlaying(false), 0);
    return () => window.clearTimeout(timer);
  }, [active, pauseAllMedia]);

  useEffect(() => () => pauseAllMedia(), [pauseAllMedia]);

  /** 口播与 BGM 在片头结束后起播;从正文中途起播时直接对齐到 bodyOffset。 */
  const syncAudioStart = useCallback((startAt: number) => {
    const bodyOffset = Math.max(0, Math.min(bodyDurationSec, startAt - INTRO_SEC));
    const delayMs = Math.max(0, (INTRO_SEC - startAt) * 1000);
    if (audioStartTimerRef.current) window.clearTimeout(audioStartTimerRef.current);
    audioStartTimerRef.current = window.setTimeout(() => {
      audioStartTimerRef.current = 0;
      if (!playingRef.current) return;
      const narration = narrationRef.current;
      if (narration && narrationUrl) {
        seekMedia(narration, bodyOffset);
        void narration.play().catch(() => undefined);
      }
      const bgmElement = bgmRef.current;
      if (bgmElement && bgm) {
        const loopDuration = Number.isFinite(bgmElement.duration) && bgmElement.duration > 0 ? bgmElement.duration : bodyDurationSec;
        seekMedia(bgmElement, bodyOffset % Math.max(0.1, loopDuration));
        void bgmElement.play().catch(() => undefined);
      }
    }, delayMs);
  }, [bgm, bodyDurationSec, narrationUrl]);

  /** 暂停态音频 seek debounce:拖动每格都 seek 口播/BGM 是无用功(暂停的音频不发声),~120ms 内只做最后一次。 */
  const pausedAudioSeekTimerRef = useRef(0);
  useEffect(() => () => {
    if (pausedAudioSeekTimerRef.current) window.clearTimeout(pausedAudioSeekTimerRef.current);
  }, []);

  const synchronizePausedAudio = useCallback((timeSec: number) => {
    if (pausedAudioSeekTimerRef.current) window.clearTimeout(pausedAudioSeekTimerRef.current);
    pausedAudioSeekTimerRef.current = window.setTimeout(() => {
      pausedAudioSeekTimerRef.current = 0;
      const bodyOffset = Math.max(0, Math.min(bodyDurationSec, timeSec - INTRO_SEC));
      seekMedia(narrationRef.current, bodyOffset);
      const bgmElement = bgmRef.current;
      if (bgmElement) {
        const loopDuration = Number.isFinite(bgmElement.duration) && bgmElement.duration > 0 ? bgmElement.duration : bodyDurationSec;
        seekMedia(bgmElement, bodyOffset % Math.max(0.1, loopDuration));
      }
    }, 120);
  }, [bodyDurationSec]);

  // 外部 seek（时间轴）与自有时钟驱动的区分:时钟驱动会先写 lastDrivenSecRef,差值≈0;
  // 外部 seek 差值大,暂停时对齐音频,播放中时基重置并对齐口播/BGM。
  useEffect(() => {
    if (Math.abs(playheadSec - lastDrivenSecRef.current) <= 1 / FPS) return;
    lastDrivenSecRef.current = playheadSec;
    if (playing) {
      clockOffsetRef.current = playheadSec;
      clockStartRef.current = performance.now();
      externalSeekUntilRef.current = performance.now() + 120;
      syncAudioStart(playheadSec);
    } else {
      synchronizePausedAudio(playheadSec);
    }
  }, [playheadSec, playing, syncAudioStart, synchronizePausedAudio]);

  // 编辑后总长变短时把播放头收回新总长;drivePlayhead 走握手,同步 effect 自动早退。
  useEffect(() => {
    if (playheadSec > totalSec) drivePlayhead(totalSec);
  }, [playheadSec, totalSec, drivePlayhead]);

  const togglePlayback = () => {
    if (!active || sortedClips.length === 0) return;
    if (playing) {
      stopPlayback();
      return;
    }
    const startAt = playheadSec >= totalSec ? 0 : playheadSec;
    clockOffsetRef.current = startAt;
    clockStartRef.current = performance.now();
    playingRef.current = true;
    setPlaying(true);
    if (startAt !== playheadSec) drivePlayhead(startAt);
    syncAudioStart(startAt);
  };

  const seek = (next: number) => {
    const clamped = Math.max(0, Math.min(totalSec, next));
    // 已暂停且没有在途 rAF/音频定时器时,跳过 stopPlayback 的全套 pauseAllMedia,避免拖动每格重复做无用功。
    if (playing || animationRef.current || audioStartTimerRef.current) stopPlayback();
    synchronizePausedAudio(clamped);
    drivePlayhead(clamped);
  };

  const toggleFullscreen = () => {
    const root = fullscreenRef.current;
    if (!root || typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void root.requestFullscreen?.();
    }
  };

  const choosePreviewMode = (mode: 'cover' | 'finished') => {
    if (mode === 'cover') seek(0);
    else if (playheadSec < INTRO_SEC) seek(INTRO_SEC);
  };

  const videoASrc = slotClips[0] ? assetsById[slotClips[0].assetId]?.previewUrl : undefined;
  const videoBSrc = slotClips[1] ? assetsById[slotClips[1].assetId]?.previewUrl : undefined;

  return (
    <div className={compact ? 'flex h-full min-h-0 flex-col gap-2' : 'space-y-2'} aria-label="成片实时预览">
      <div
        ref={fullscreenRef}
        className={`${compact ? 'flex min-h-0 flex-1 items-center justify-center overflow-hidden' : 'flex justify-center'} ${styles.fullscreenShell}`}
        style={{ '--batch-preview-ratio': size.width / size.height } as CSSProperties}
      >
        <div
          ref={stageRef}
          className={`${styles.stage} relative overflow-hidden rounded-xl bg-black`}
          style={compact
            ? {
              aspectRatio: `${size.width} / ${size.height}`,
              width: size.width >= size.height ? '100%' : 'auto',
              height: size.width >= size.height ? 'auto' : '100%',
              maxWidth: '100%',
              maxHeight: '100%',
            }
            : size.width >= size.height
              ? { aspectRatio: `${size.width} / ${size.height}`, width: '100%' }
              : { aspectRatio: `${size.width} / ${size.height}`, height: 'min(52vh, 560px)' }}
        >
          <video ref={videoARef} src={videoASrc} className="pointer-events-none absolute h-px w-px opacity-0" muted playsInline preload="auto" aria-hidden="true" />
          <video ref={videoBRef} src={videoBSrc} className="pointer-events-none absolute h-px w-px opacity-0" muted playsInline preload="auto" aria-hidden="true" />
          <canvas ref={frameCanvasRef} width={size.width} height={size.height} className="absolute inset-0 h-full w-full" />
          {showCover && (
            coverUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={coverUrl} alt="片头封面" className="absolute inset-0 h-full w-full object-cover" />
              : <div className="absolute inset-0 flex items-center justify-center text-xs text-surface/70">片头封面</div>
          )}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={activeCue?.text ? `字幕：${activeCue.text}` : '字幕预览'}
            dangerouslySetInnerHTML={{ __html: subtitleSvg }}
          />
          {showSafeArea && <div className="pointer-events-none absolute inset-[4%] rounded-md border border-dashed border-surface/55" aria-label="4% 预览安全区" />}
          {sortedClips.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-surface/70">没有可预览的片段</div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary h-8 w-8 shrink-0 rounded-full text-xs"
          aria-label={playing ? '暂停' : '播放'}
          disabled={!active || sortedClips.length === 0}
          onClick={togglePlayback}
        >{playing ? 'Ⅱ' : '▶'}</button>
        <span className="shrink-0 text-xs tabular-nums text-ink-secondary">{formatTime(playheadSec)} / {formatTime(totalSec)}</span>
        <input
          aria-label="播放位置"
          type="range"
          className="min-w-0 flex-1"
          min={0}
          max={Math.max(totalSec, 1 / FPS)}
          step={1 / FPS}
          value={Math.min(playheadSec, totalSec)}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="flex shrink-0 items-center gap-1 rounded-lg bg-surface-subtle p-1" role="group" aria-label="预览内容切换">
          <button type="button" className={`rounded-md px-2 py-1 text-[11px] ${previewMode === 'cover' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary'}`} aria-pressed={previewMode === 'cover'} onClick={() => choosePreviewMode('cover')}>封面</button>
          <button type="button" className={`rounded-md px-2 py-1 text-[11px] ${previewMode === 'finished' ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary'}`} aria-pressed={previewMode === 'finished'} onClick={() => choosePreviewMode('finished')}>成片</button>
        </div>
        <button
          type="button"
          className={`btn-secondary h-8 shrink-0 px-2 text-[11px] ${showSafeArea ? 'border-accent text-accent' : ''}`}
          aria-label={showSafeArea ? '隐藏安全区' : '显示安全区'}
          aria-pressed={showSafeArea}
          onClick={() => setShowSafeArea((current) => !current)}
        >安全区</button>
        <button type="button" className="btn-secondary h-8 shrink-0 px-3 text-[11px]" aria-label="全屏预览" title="全屏预览" onClick={toggleFullscreen}>全屏</button>
      </div>
      <audio ref={narrationRef} preload="auto" src={narrationUrl ?? undefined} />
      <audio ref={bgmRef} preload="auto" loop src={bgm?.fileUrl} />
    </div>
  );
}
