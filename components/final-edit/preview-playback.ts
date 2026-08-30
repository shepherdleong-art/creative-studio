import type { OutputPresetId } from '@/lib/final-edit/types';
import { NARRATION_GAIN_DB_DEFAULT, narrationGainLinear } from '../../lib/media-core/audio-gain.ts';

export type VideoSlot = 0 | 1;

export interface VideoSlotPlan {
  activeSlot: VideoSlot | null;
  clipIndexes: [number | null, number | null];
}

/**
 * Keep each active clip in the same decoder slot for its whole lifetime and
 * load the following clip into the other slot before the cut. While the cover
 * is visible we preload clips 0 and 1, so the first body frame never swaps src.
 */
export function getVideoSlotPlan(activeClipIndex: number, clipCount: number): VideoSlotPlan {
  const inRange = (index: number) => index >= 0 && index < clipCount ? index : null;
  if (activeClipIndex < 0) return { activeSlot: null, clipIndexes: [inRange(0), inRange(1)] };
  if (activeClipIndex % 2 === 0) {
    return { activeSlot: 0, clipIndexes: [inRange(activeClipIndex), inRange(activeClipIndex + 1)] };
  }
  return { activeSlot: 1, clipIndexes: [inRange(activeClipIndex + 1), inRange(activeClipIndex)] };
}

export function expectedVideoTimeSec(sourceInFrame: number, timelineInFrame: number, bodyFrame: number, fps: number): number {
  return sourceInFrame / fps + Math.max(0, bodyFrame - timelineInFrame) / fps;
}

/**
 * Seek coalescing: while a seek is still in flight we never write currentTime
 * again — the pending target is remembered by the caller and re-applied from a
 * persistent `seeked` listener. This keeps `seeked` fireable even when the
 * playhead moves every frame (scrubbing), instead of being cancelled by the
 * next assignment before it ever completes.
 */
export function shouldIssueSeek(
  video: { seeking: boolean; currentTime: number },
  targetSec: number,
  toleranceSec: number,
): boolean {
  if (video.seeking) return false;
  return Math.abs(video.currentTime - targetSec) > toleranceSec;
}

export function bgmGainAtTime({ bodyTimeSec, bodyDurationSec, gainDb, fadeInSec, fadeOutSec }: {
  bodyTimeSec: number;
  bodyDurationSec: number;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}): number {
  if (bodyTimeSec < 0 || bodyTimeSec >= bodyDurationSec || bodyDurationSec <= 0) return 0;
  const baseGain = Math.min(1, Math.pow(10, gainDb / 20));
  const fadeIn = fadeInSec > 0 ? Math.min(1, bodyTimeSec / fadeInSec) : 1;
  const remaining = Math.max(0, bodyDurationSec - bodyTimeSec);
  const fadeOut = fadeOutSec > 0 ? Math.min(1, remaining / fadeOutSec) : 1;
  return baseGain * fadeIn * fadeOut;
}

export function narrationGainAtTime({ bodyTimeSec, bodyDurationSec, gainDb }: {
  bodyTimeSec: number;
  bodyDurationSec: number;
  gainDb: number;
}): number {
  if (bodyTimeSec < 0 || bodyTimeSec >= bodyDurationSec || bodyDurationSec <= 0) return 0;
  return narrationGainLinear(gainDb);
}

export function previewAudioLevelsAtTime({ playheadSec, introSec, bodyDurationSec, narrationGainDb = NARRATION_GAIN_DB_DEFAULT, gainDb, fadeInSec, fadeOutSec }: {
  playheadSec: number;
  introSec: number;
  bodyDurationSec: number;
  narrationGainDb?: number;
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}): { narrationGain: number; bgmGain: number } {
  const bodyTimeSec = playheadSec - introSec;
  const narrationGain = narrationGainAtTime({ bodyTimeSec, bodyDurationSec, gainDb: narrationGainDb });
  return {
    narrationGain,
    bgmGain: bgmGainAtTime({ bodyTimeSec, bodyDurationSec, gainDb, fadeInSec, fadeOutSec }),
  };
}

interface PreviewFraming {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function fittedRect(canvas: HTMLCanvasElement, video: HTMLVideoElement, mode: 'cover' | 'contain', framing: PreviewFraming) {
  const fit = (mode === 'cover'
    ? Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    : Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)) * framing.scale;
  const width = video.videoWidth * fit;
  const height = video.videoHeight * fit;
  return {
    x: (canvas.width - width) / 2 + framing.offsetX * Math.abs(canvas.width - width) / 2,
    y: (canvas.height - height) / 2 + framing.offsetY * Math.abs(canvas.height - height) / 2,
    width,
    height,
  };
}

/**
 * Paint only a genuinely decoded frame. When a decoder is still seeking we do
 * nothing, deliberately retaining the previous canvas pixels across the cut.
 */
export function paintDecodedVideoFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  preset: OutputPresetId,
  framing: PreviewFraming,
): boolean {
  if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) return false;

  context.save();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111827';
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (preset === '16x9') {
    const background = fittedRect(canvas, video, 'cover', { scale: 1.08, offsetX: 0, offsetY: 0 });
    context.save();
    context.filter = 'blur(32px)';
    context.drawImage(video, background.x, background.y, background.width, background.height);
    context.restore();
    const foreground = fittedRect(canvas, video, 'contain', framing);
    context.drawImage(video, foreground.x, foreground.y, foreground.width, foreground.height);
  } else {
    const frame = fittedRect(canvas, video, 'cover', framing);
    context.drawImage(video, frame.x, frame.y, frame.width, frame.height);
  }

  context.restore();
  return true;
}
