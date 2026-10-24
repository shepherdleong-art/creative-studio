import { FINAL_EDIT_FPS } from '../../../lib/media-core/render-contract.ts';

type ClipPosition = { clipId: string; timelineStartUs: number; timelineEndUs: number };

export interface MaterialDropTarget {
  planId: string;
  type: 'replace' | 'insert' | 'append';
  clipId?: string;
  afterClipId?: string | null;
  timelineStartUs?: number;
}

/** 悬停阶段浏览器不允许读取拖拽数据，素材池把条数编码在自定义 MIME 类型名里。 */
export const MATERIAL_DRAG_COUNT_PREFIX = 'application/x-live-mixcut-count-';
/** 插入片段最短 0.5 秒；默认取用 3 秒。 */
export const MATERIAL_DROP_MIN_US = 500_000;
export const MATERIAL_DROP_MAX_US = 3_000_000;

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

/** 从拖拽 MIME 类型里读出本次素材条数；未携带时按单条处理。 */
export function materialDragCount(types: readonly string[]): number {
  for (const type of types) {
    const match = /^application\/x-live-mixcut-count-(\d+)$/u.exec(type);
    if (match) return Math.min(50, Math.max(1, Number(match[1])));
  }
  return 1;
}

/**
 * 多条素材落到片段上只能插入；返回该片段前的插入锚点。
 * 替换/插入/追加三种落点共用同一份锚点计算。
 */
export function materialInsertAnchor(clips: ClipPosition[], target: MaterialDropTarget) {
  if (target.type === 'replace' && target.clipId) {
    const index = clips.findIndex(clip => clip.clipId === target.clipId);
    const clip = clips[index];
    if (!clip) return null;
    return { afterClipId: clips[index - 1]?.clipId ?? null, timelineStartUs: clip.timelineStartUs };
  }
  if (target.type === 'append' && target.timelineStartUs === undefined) {
    return { afterClipId: clips.at(-1)?.clipId ?? null, timelineStartUs: undefined };
  }
  return {
    afterClipId: target.afterClipId ?? (target.type === 'append' ? clips.at(-1)?.clipId ?? null : null),
    timelineStartUs: target.timelineStartUs,
  };
}

/** 插入默认取 3 秒且不超过素材本身，按 24fps 对齐；不足 0.5 秒时由调用方拒绝。 */
export function materialInsertDurationUs(durationSec: number | null): number {
  const assetUs = durationSec != null && Number.isFinite(durationSec)
    ? Math.floor(durationSec * 1_000_000) : MATERIAL_DROP_MAX_US;
  const frames = Math.floor(Math.min(MATERIAL_DROP_MAX_US, assetUs) * FINAL_EDIT_FPS / 1_000_000);
  return Math.round(frames * 1_000_000 / FINAL_EDIT_FPS);
}
