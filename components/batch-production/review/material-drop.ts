import { FINAL_EDIT_FPS } from '../../../lib/media-core/render-contract.ts';

type ClipPosition = { clipId: string; timelineStartUs: number; timelineEndUs: number };

/** 空白视频轨道的坐标已经扣除轨道左侧位置（含水平滚动）。 */
export function materialDropInGap(clips: ClipPosition[], offsetPx: number, zoom: number) {
  const frame = Math.round(Math.max(0, offsetPx) / zoom * FINAL_EDIT_FPS);
  const timelineStartUs = Math.round(frame * 1_000_000 / FINAL_EDIT_FPS);
  if (clips.some(clip => timelineStartUs >= clip.timelineStartUs && timelineStartUs < clip.timelineEndUs)) return null;
  const previous = clips.filter(clip => clip.timelineEndUs <= timelineStartUs).at(-1);
  return {
    type: clips.some(clip => clip.timelineStartUs > timelineStartUs) ? 'insert' as const : 'append' as const,
    afterClipId: previous?.clipId ?? null,
    timelineStartUs,
  };
}
