import { snapMovingClip } from './timeline-snap.ts';
import {
  STICKER_FPS,
  STICKER_INTRO_FRAMES,
  STICKER_MIN_DURATION_FRAMES,
  type PackagingStickerInstance,
} from './packaging-stickers.ts';

/** 时间轴显示顺序与渲染层级共用：trackIndex 越小越靠上；旧数据同轨重叠时后添加者在上。 */
export function layoutPackagingStickerTracks(stickers: PackagingStickerInstance[]): PackagingStickerInstance[] {
  const rows: Array<Array<{ startFrame: number; endFrame: number }>> = [];
  return stickers
    .map((sticker, index) => ({ sticker, index }))
    .sort((left, right) => left.sticker.trackIndex - right.sticker.trackIndex || right.index - left.index)
    .map(({ sticker }) => {
      let trackIndex = rows.findIndex((items) => items.every((item) => sticker.endFrame <= item.startFrame || sticker.startFrame >= item.endFrame));
      if (trackIndex < 0) trackIndex = rows.length;
      (rows[trackIndex] ??= []).push(sticker);
      return { ...sticker, trackIndex };
    });
}

/** 写命令统一归一化轨道，但保留原数组顺序和其他编辑字段，不把归一化本身记成用户编辑。 */
export function normalizePackagingStickerTracks(stickers: PackagingStickerInstance[]): PackagingStickerInstance[] {
  const trackById = new Map(layoutPackagingStickerTracks(stickers).map((sticker) => [sticker.id, sticker.trackIndex]));
  return stickers.map((sticker) => ({ ...sticker, trackIndex: trackById.get(sticker.id) ?? sticker.trackIndex }));
}

export function insertPackagingStickerAtTop(stickers: PackagingStickerInstance[], sticker: PackagingStickerInstance): PackagingStickerInstance[] {
  return normalizePackagingStickerTracks([
    { ...sticker, trackIndex: 0 },
    ...stickers.map((item) => ({ ...item, trackIndex: item.trackIndex + 1 })),
  ]);
}

/** 把实例移动到目标显示轨；只调整层级，帧范围与其他编辑字段保持不变。 */
export function movePackagingStickerToTrack(stickers: PackagingStickerInstance[], stickerId: string, targetTrackIndex: number): PackagingStickerInstance[] {
  const laidOut = layoutPackagingStickerTracks(stickers);
  const source = laidOut.find((sticker) => sticker.id === stickerId);
  if (!source) return stickers;
  const trackCount = laidOut.reduce((count, sticker) => Math.max(count, sticker.trackIndex + 1), 1);
  const target = Math.max(0, Math.min(trackCount - 1, Math.trunc(targetTrackIndex)));
  if (source.trackIndex === target) return normalizePackagingStickerTracks(stickers);
  const rows = Array.from({ length: trackCount }, () => [] as PackagingStickerInstance[]);
  for (const sticker of laidOut) rows[sticker.trackIndex].push(sticker);
  rows[source.trackIndex] = rows[source.trackIndex].filter((sticker) => sticker.id !== stickerId);
  if (source.trackIndex < target) rows[target].push(source);
  else rows[target].unshift(source);
  const rankById = new Map(rows.flat().map((sticker, index) => [sticker.id, index]));
  return normalizePackagingStickerTracks(stickers.map((sticker) => ({
    ...sticker,
    trackIndex: rankById.get(sticker.id) ?? sticker.trackIndex,
  })));
}

export function planPackagingStickerFrames(sticker: PackagingStickerInstance, input: {
  mode: 'move' | 'start' | 'end';
  deltaFrames: number;
  bodyEndFrame: number;
  candidates?: number[];
  preferredCandidates?: number[];
  pxPerSecond?: number;
  snapEnabled?: boolean;
}): { startFrame: number; endFrame: number; snapSec: number | null } {
  const durationFrames = sticker.endFrame - sticker.startFrame;
  const edgeFrame = (input.mode === 'end' ? sticker.endFrame : sticker.startFrame) + input.deltaFrames;
  const snapped = snapMovingClip({
    startSec: edgeFrame / STICKER_FPS,
    durationSec: input.mode === 'move' ? durationFrames / STICKER_FPS : 0,
    candidates: input.candidates ?? [],
    preferredCandidates: input.preferredCandidates ?? [],
    pxPerSecond: input.pxPerSecond ?? 60,
    enabled: input.snapEnabled === true,
    fps: STICKER_FPS,
  });
  const edge = Math.round(snapped.startSec * STICKER_FPS);
  if (input.mode === 'move') {
    const startFrame = Math.min(input.bodyEndFrame - durationFrames, Math.max(STICKER_INTRO_FRAMES, edge));
    return { startFrame, endFrame: startFrame + durationFrames, snapSec: snapped.snapSec };
  }
  if (input.mode === 'start') {
    return { startFrame: Math.min(sticker.endFrame - STICKER_MIN_DURATION_FRAMES, Math.max(STICKER_INTRO_FRAMES, edge)), endFrame: sticker.endFrame, snapSec: snapped.snapSec };
  }
  return { startFrame: sticker.startFrame, endFrame: Math.min(input.bodyEndFrame, Math.max(sticker.startFrame + STICKER_MIN_DURATION_FRAMES, edge)), snapSec: snapped.snapSec };
}
