import { TimelineSolverError } from './solve-timeline.ts';
import type { ClipPoolItem, TimelineIssue, TimelineResult, TimelineSegment } from './types.ts';

const SECONDS_EPSILON = 1e-9;
/** 纯 BGM 蒙太奇的单画面上限。narration 路径已无上限（口播定长度），BGM 没有口播，仍需要一个节奏闸门。
 *  原实现是 Math.min(config.maxClipSeconds, 4) 且 config 默认就是 4 —— 恒等于 4，故行为逐位不变。 */
const BGM_MAX_CLIP_SECONDS = 4;

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

function fail(code: string, message: string): never {
  throw new TimelineSolverError(code, message);
}

function warning(code: TimelineIssue['code'], message: string, clipId: string): TimelineIssue {
  return { code, severity: 'warning', message, beatIds: [], clipId };
}

/**
 * Builds a deterministic BGM-only timeline from the user's explicit clip selection.
 * The requested target already includes any cover intro; only a material shortfall
 * may extend the final selected frame with a freeze.
 */
export function solveBgmTimeline(input: {
  selectedClipIds: string[];
  clips: ClipPoolItem[];
  introDurationSec: number;
  targetDurationSec: number;
  fps: number;
}): TimelineResult {
  if (!finitePositive(input.fps)) fail('invalid_fps', '帧率必须是有限正数');
  if (!finitePositive(input.targetDurationSec)) fail('invalid_target_duration', '目标时长必须是有限正数');
  if (!finiteNonNegative(input.introDurationSec)) fail('invalid_intro_duration', '片头时长必须是有限非负数');
  if (input.targetDurationSec - input.introDurationSec <= SECONDS_EPSILON) {
    fail('target_duration_without_content', '目标时长必须大于片头时长');
  }
  if (input.selectedClipIds.length === 0) fail('no_selected_clips', '请至少选择一条视频素材');

  const clipById = new Map<string, ClipPoolItem>();
  for (const clip of input.clips) {
    if (clipById.has(clip.clipId) || !finitePositive(clip.clipDurationSec)) {
      fail('invalid_clips', '候选画面必须具有唯一编号和有限正时长');
    }
    clipById.set(clip.clipId, clip);
  }

  const selected = input.selectedClipIds.map((clipId) => {
    const clip = clipById.get(clipId);
    if (!clip) fail('selected_clip_missing', `已选择的视频素材不存在：${clipId}`);
    return clip;
  });
  if (new Set(input.selectedClipIds).size !== input.selectedClipIds.length) {
    fail('duplicate_selected_clip', '同一视频素材不能重复选择');
  }

  const contentDurationSec = input.targetDurationSec - input.introDurationSec;
  const segments: TimelineSegment[] = [];
  let cursor = 0;
  for (const clip of selected) {
    const remaining = contentDurationSec - cursor;
    if (remaining <= SECONDS_EPSILON) break;
    const mediaDurationSec = Math.min(remaining, clip.clipDurationSec, BGM_MAX_CLIP_SECONDS);
    const segment: TimelineSegment = {
      order: segments.length,
      clipId: clip.clipId,
      clipPath: clip.videoPath,
      intendedBeatIds: [],
      coveredBeatIds: [],
      gapBeatIds: [],
      clipDurationSec: clip.clipDurationSec,
      mediaDurationSec,
      trimEndToSec: clip.clipDurationSec - mediaDurationSec > SECONDS_EPSILON ? mediaDurationSec : null,
      padStopSec: 0,
      segmentDurationSec: mediaDurationSec,
      startSec: input.introDurationSec + cursor,
    };
    segments.push(segment);
    cursor += mediaDurationSec;
  }

  if (segments.length === 0) fail('no_selected_clips', '请至少选择一条视频素材');
  const remaining = Math.max(0, contentDurationSec - cursor);
  const issues: TimelineIssue[] = [];
  if (remaining > SECONDS_EPSILON) {
    const last = segments.at(-1) as TimelineSegment;
    last.padStopSec = remaining;
    last.segmentDurationSec += remaining;
    cursor += remaining;
    issues.push(warning('last_clip_frozen', '最后画面已定格以覆盖目标时长', last.clipId));
    if (last.segmentDurationSec - BGM_MAX_CLIP_SECONDS > SECONDS_EPSILON) {
      issues.push(warning('last_clip_exceeds_max_after_fallback', '末段兜底后超过单画面时长上限', last.clipId));
    }
  }

  return { segments, issues, contentDurationSec, totalDurationSec: input.targetDurationSec };
}

export { TimelineSolverError };
