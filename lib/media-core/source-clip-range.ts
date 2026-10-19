import { FINAL_EDIT_FPS } from './render-contract.ts';

/** Source monitor edits keep the timeline start fixed, unlike edge trims. */
export function sourceClipRange(input: {
  sourceStartUs: number; sourceEndUs: number; sourceDurationUs: number;
  timelineStartUs: number; nextTimelineStartUs?: number; playbackRate: number;
}) {
  const { playbackRate: rate } = input;
  if (![input.sourceStartUs, input.sourceEndUs, input.sourceDurationUs, input.timelineStartUs].every(Number.isSafeInteger)
    || input.sourceStartUs < 0 || input.sourceEndUs <= input.sourceStartUs
    || input.sourceEndUs > input.sourceDurationUs || input.timelineStartUs < 0 || !Number.isFinite(rate) || rate < 0.25 || rate > 4) {
    throw new Error('出入点无效或超出素材范围');
  }
  const align = (us: number) => Math.round(Math.round(us / 1e6 * FINAL_EDIT_FPS) / FINAL_EDIT_FPS * 1e6);
  const sourceStartUs = align(input.sourceStartUs);
  const sourceEndUs = Math.min(input.sourceDurationUs, align(input.sourceEndUs));
  const timelineEndUs = input.timelineStartUs + Math.round((sourceEndUs - sourceStartUs) / rate);
  if (timelineEndUs - input.timelineStartUs < 500_000) throw new Error('选段播放时长不能短于 0.5 秒');
  if (timelineEndUs > (input.nextTimelineStartUs ?? Infinity)) throw new Error('选段超出当前空位，请缩短选段或先移动相邻片段');
  return { sourceStartUs, sourceEndUs, timelineStartUs: input.timelineStartUs, timelineEndUs };
}
