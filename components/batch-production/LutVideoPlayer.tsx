'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createLutRenderer, loadCubeLutFromEndpoint, type ParsedCubeLut } from './lut-3d';

import type { LutFileSource } from './lut-3d';

export type LutVideoSource = LutFileSource;

/**
 * C2 单视频播放包装:常规播放交给 <video>,有 LUT 时叠加 WebGL canvas 逐帧绘制
 * (3D 纹理硬件三线性,与 ffmpeg lut3d trilinear 同数学)。
 *
 * - 无 LUT 或 WebGL2 不可用:完全直通(不创建 GL 上下文,零成本);
 * - 换 LUT 只换纹理/重绘,不换源、不重载 video;
 * - 与代理/原片开关正交:LUT 叠加在任一源上都生效;
 * - LUT 渲染模式用自绘轻量控件(原生 controls 被 canvas 覆盖后不可见),
 *   直通模式保留原生 controls。
 */
export function LutVideoPlayer({
  src,
  poster,
  ariaLabel,
  lut,
  videoRef,
  onLoadedMetadata,
  onError,
  className,
}: {
  src: string;
  poster?: string;
  ariaLabel?: string;
  /** 当前素材选中的 LUT;为 null 时直通(不创建 GL 上下文) */
  lut: LutVideoSource | null;
  /** 透传给内部 <video>(调用方用它做换源保位/回退等) */
  videoRef?: RefObject<HTMLVideoElement | null>;
  onLoadedMetadata?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onError?: () => void;
  className?: string;
}) {
  const internalVideoRef = useRef<HTMLVideoElement | null>(null);
  const resolveVideo = useCallback((): HTMLVideoElement | null => (videoRef ?? internalVideoRef).current, [videoRef]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ReturnType<typeof createLutRenderer> | null>(null);
  const [lutState, setLutState] = useState<
    { id: string; status: 'loading' | 'ready' | 'error'; parsed?: ParsedCubeLut; error?: string }
  | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progressSec, setProgressSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [muted, setMuted] = useState(false);

  const webgl2Available = typeof WebGL2RenderingContext !== 'undefined';
  const glActive = Boolean(lut && webgl2Available && lutState?.status === 'ready' && lutState.id === lut.lutId);

  // LUT 文本加载(fetch + parse;跨组件按 lutId 缓存解析结果)
  useEffect(() => {
    if (!lut) return;
    let cancelled = false;
    void (async () => {
      try {
        const parsed = await loadCubeLutFromEndpoint(lut);
        if (!cancelled) setLutState({ id: lut.lutId, status: 'ready', parsed });
      } catch (error) {
        if (!cancelled) {
          setLutState({
            id: lut.lutId,
            status: 'error',
            error: error instanceof Error ? error.message : 'LUT 解析失败',
          });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lut?.lutId]);

  // GL 上下文仅在 LUT 渲染模式下创建/销毁;直通模式不创建、零成本
  useEffect(() => {
    if (!glActive) {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // createLutRenderer 在 shader 编译/链接失败时会 throw;GL 异常必须降级为
    // "无 LUT 直通 + 提示",不能让组件崩溃(与 WebGL2 不可用同路径)。
    let renderer: ReturnType<typeof createLutRenderer> | null = null;
    try {
      renderer = createLutRenderer(canvas);
    } catch {
      renderer = null;
    }
    rendererRef.current = renderer;
    if (renderer && lutState?.parsed) renderer.setLut(lutState.parsed);
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [glActive, lutState]);

  // 逐帧绘制:requestVideoFrameCallback 优先,退化 rAF
  useEffect(() => {
    if (!glActive) return;
    const videoElement = resolveVideo();
    const renderer = rendererRef.current;
    if (!videoElement || !renderer) return;
    let cancelled = false;
    let frameHandle = 0;
    const drawOnce = () => { if (!cancelled) renderer.drawFrame(videoElement); };
    const videoWithFrameCallback = videoElement as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (typeof videoWithFrameCallback.requestVideoFrameCallback === 'function') {
      const schedule = () => {
        if (cancelled) return;
        frameHandle = videoWithFrameCallback.requestVideoFrameCallback!(() => { drawOnce(); schedule(); });
      };
      schedule();
    } else {
      const loop = () => { if (cancelled) return; drawOnce(); frameHandle = requestAnimationFrame(loop); };
      loop();
    }
    return () => {
      cancelled = true;
      // rVFC 与 rAF 的 handle 属于不同的 id 空间,两个 cancel 都调用(命名互不相扰,
      // 老浏览器没有 cancelVideoFrameCallback 时静默跳过)。
      cancelAnimationFrame(frameHandle);
      videoWithFrameCallback.cancelVideoFrameCallback?.(frameHandle);
    };
  }, [glActive, lutState, videoRef, resolveVideo]);

  // 播放器状态(自绘控件用)
  useEffect(() => {
    const videoElement = resolveVideo();
    if (!videoElement || !glActive) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTime = () => setProgressSec(videoElement.currentTime);
    const onDuration = () => setDurationSec(Number.isFinite(videoElement.duration) ? videoElement.duration : 0);
    const onVolume = () => setMuted(videoElement.muted || videoElement.volume === 0);
    videoElement.addEventListener('play', onPlay);
    videoElement.addEventListener('pause', onPause);
    videoElement.addEventListener('timeupdate', onTime);
    videoElement.addEventListener('durationchange', onDuration);
    videoElement.addEventListener('volumechange', onVolume);
    onPlay(); onPause(); onTime(); onDuration(); onVolume();
    return () => {
      videoElement.removeEventListener('play', onPlay);
      videoElement.removeEventListener('pause', onPause);
      videoElement.removeEventListener('timeupdate', onTime);
      videoElement.removeEventListener('durationchange', onDuration);
      videoElement.removeEventListener('volumechange', onVolume);
    };
  }, [glActive, videoRef, resolveVideo]);

  const togglePlayback = () => {
    const videoElement = resolveVideo();
    if (!videoElement) return;
    if (videoElement.paused || videoElement.ended) void videoElement.play().catch(() => undefined);
    else videoElement.pause();
  };
  const toggleMute = () => {
    const videoElement = resolveVideo();
    if (!videoElement) return;
    videoElement.muted = !videoElement.muted;
  };
  const seekTo = (sec: number) => {
    const videoElement = resolveVideo();
    if (!videoElement) return;
    try { videoElement.currentTime = Math.max(0, sec); } catch { /* 换源瞬间可能不可写 */ }
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      <video
        ref={videoRef ?? internalVideoRef}
        src={src}
        poster={poster}
        aria-label={ariaLabel}
        className={glActive
          ? 'pointer-events-none h-full w-full object-contain opacity-0'
          : 'h-full w-full object-contain'}
        controls={!glActive}
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
      />
      {glActive && (
        <>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-xl bg-black/55 px-2 py-1.5">
            <button
              type="button"
              className="w-8 shrink-0 rounded-lg bg-white/15 text-xs text-white"
              aria-label={playing ? '暂停' : '播放'}
              onClick={togglePlayback}
            >{playing ? 'Ⅱ' : '▶'}</button>
            <input
              aria-label="播放位置"
              type="range"
              className="min-w-0 flex-1"
              min={0}
              max={Math.max(durationSec, 0.01)}
              step={0.01}
              value={Math.min(progressSec, durationSec || 0)}
              onChange={(event) => seekTo(Number(event.target.value))}
            />
            <span className="shrink-0 text-[11px] tabular-nums text-white/85">
              {formatTime(progressSec)}{durationSec > 0 ? ` / ${formatTime(durationSec)}` : ''}
            </span>
            <button
              type="button"
              className="w-8 shrink-0 rounded-lg bg-white/15 text-xs text-white"
              aria-label={muted ? '取消静音' : '静音'}
              aria-pressed={muted}
              onClick={toggleMute}
            >{muted ? '🔇' : '🔊'}</button>
          </div>
        </>
      )}
      {lut && !webgl2Available && (
        <p className="mt-1 text-[11px] text-warn" role="status">
          当前设备不支持实时 LUT 预览（需要 WebGL2）；预览为实时近似效果，以正式导出成片为准。
        </p>
      )}
      {lutState?.status === 'error' && (
        <p className="mt-1 text-[11px] text-fail" role="alert">LUT 解析失败：{lutState.error}（当前播放未叠加 LUT；预览为实时近似效果，以正式导出成片为准。）</p>
      )}
      {lut && lutState?.id !== lut.lutId && (
        <p className="mt-1 text-[11px] text-ink-tertiary" role="status">正在加载 LUT…</p>
      )}
    </div>
  );
}

function formatTime(timeSec: number): string {
  const value = Math.max(0, timeSec);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`;
}
