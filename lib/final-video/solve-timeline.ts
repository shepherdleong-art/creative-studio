import { validateArrangement } from './arrangement.ts';
import type {
  ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineIssue, TimelineResult, TimelineSegment,
} from './types.ts';

const SECONDS_EPSILON = 1e-9;

export class TimelineSolverError extends Error {
  readonly code: string;
  readonly issues: TimelineIssue[];

  constructor(
    code: string,
    message: string,
    issues: TimelineIssue[] = [],
  ) {
    super(message);
    this.name = 'TimelineSolverError';
    this.code = code;
    this.issues = issues;
  }
}

const fail = (code: string, message: string): never => { throw new TimelineSolverError(code, message); };
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

function validateInput(input: {
  plan: ArrangementPlan; beats: NarrationBeat[]; clips: ClipPoolItem[]; introDurationSec: number;
  targetDurationSec: number; durationTolerancePct: number; maxClipSeconds: number; fps: number;
}): { beats: NarrationBeat[]; clips: ClipPoolItem[]; plan: ArrangementPlan } {
  if (!finitePositive(input.fps)) fail('invalid_fps', '帧率必须是有限正数');
  if (!finitePositive(input.targetDurationSec)) fail('invalid_target_duration', '目标时长必须是有限正数');
  if (!finitePositive(input.maxClipSeconds)) fail('invalid_max_clip_seconds', '单画面时长上限必须是有限正数');
  if (!finiteNonNegative(input.introDurationSec)) fail('invalid_intro_duration', '片头时长必须是有限非负数');
  if (!finiteNonNegative(input.durationTolerancePct)) fail('invalid_duration_tolerance', '时长容差必须是有限非负数');
  if (input.clips.length === 0) fail('no_visual_source', '没有可用的候选画面');

  const beats = [...input.beats].sort((left, right) => left.index - right.index);
  const beatIds = new Set<string>();
  const beatIndexes = new Set<number>();
  for (const [position, beat] of beats.entries()) {
    if (beatIds.has(beat.beatId) || beatIndexes.has(beat.index) || beat.index !== position || !finitePositive(beat.durationSec)) {
      fail('invalid_beats', '口播节拍必须具有唯一编号、连续索引和有限正时长');
    }
    beatIds.add(beat.beatId);
    beatIndexes.add(beat.index);
  }

  const clips = input.clips.map((clip) => ({ ...clip }));
  const clipIds = new Set<string>();
  for (const clip of clips) {
    if (clipIds.has(clip.clipId) || !finitePositive(clip.clipDurationSec)) {
      fail('invalid_clips', '候选画面必须具有唯一编号和有限正时长');
    }
    clipIds.add(clip.clipId);
  }

  const validation = validateArrangement(input.plan, beats, clips, input.maxClipSeconds);
  if (!validation.ok) {
    throw new TimelineSolverError('invalid_arrangement', '编排内容无效', validation.issues.map((issue) => ({ ...issue, beatIds: [...issue.beatIds] })));
  }
  return { beats, clips, plan: validation.plan };
}

const warning = (code: TimelineIssue['code'], message: string, beatIds: string[], clipId: string | null): TimelineIssue => ({
  code, severity: 'warning', message, beatIds: [...beatIds], clipId,
});

export function solveTimeline(input: {
  plan: ArrangementPlan;
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  introDurationSec: number;
  targetDurationSec: number;
  durationTolerancePct: number;
  maxClipSeconds: number;
  fps: number;
}): TimelineResult {
  const { beats, clips, plan } = validateInput(input);
  const rawNarrationDurationSec = beats.reduce((sum, beat) => sum + beat.durationSec, 0);
  let contentFrames = Math.ceil(rawNarrationDurationSec * input.fps);
  if (contentFrames / input.fps < rawNarrationDurationSec) contentFrames += 1;
  const contentDurationSec = contentFrames / input.fps;
  const totalDurationSec = input.introDurationSec + contentDurationSec;
  const clipById = new Map(clips.map((clip) => [clip.clipId, clip]));
  const gapByBeatId = new Map(plan.gaps.map((gap) => [gap.beatId, gap]));
  const intervals = new Map<string, { start: number; end: number }>();
  let beatCursor = 0;
  for (const beat of beats) {
    intervals.set(beat.beatId, { start: beatCursor, end: beatCursor + beat.durationSec });
    beatCursor += beat.durationSec;
  }
  const covered = (start: number, end: number) => beats
    .filter((beat) => {
      const interval = intervals.get(beat.beatId) as { start: number; end: number };
      return interval.start < end && interval.end > start;
    })
    .map((beat) => beat.beatId);
  const applyCoverage = (segment: TimelineSegment, contentStart: number) => {
    segment.coveredBeatIds = covered(contentStart, contentStart + segment.segmentDurationSec);
    segment.gapBeatIds = segment.coveredBeatIds.filter((beatId) => gapByBeatId.has(beatId));
  };

  const segments: TimelineSegment[] = [];
  const issues: TimelineIssue[] = [];
  let cursor = 0;
  for (const [assignmentIndex, assignment] of plan.assignments.entries()) {
    const clip = clipById.get(assignment.clipId) as ClipPoolItem;
    const lastBeatId = assignment.beatIds.at(-1) as string;
    const targetEnd = (intervals.get(lastBeatId) as { start: number; end: number }).end;
    const wanted = Math.max(0, targetEnd - cursor);
    let mediaDurationSec = Math.min(wanted, clip.clipDurationSec, input.maxClipSeconds);

    // Every boundary before another segment lies on a frame. Quantizing down preserves all three caps;
    // any fractional carry is deliberately picked up by the following assignment.
    if (assignmentIndex < plan.assignments.length - 1) {
      const alignedEnd = Math.floor((cursor + mediaDurationSec) * input.fps + SECONDS_EPSILON) / input.fps;
      mediaDurationSec = Math.max(0, alignedEnd - cursor);
    }
    const segmentStart = cursor;
    const segment: TimelineSegment = {
      order: segments.length,
      clipId: clip.clipId,
      clipPath: clip.videoPath,
      intendedBeatIds: [...assignment.beatIds],
      coveredBeatIds: [],
      gapBeatIds: [],
      clipDurationSec: clip.clipDurationSec,
      mediaDurationSec,
      trimEndToSec: clip.clipDurationSec - mediaDurationSec > SECONDS_EPSILON ? mediaDurationSec : null,
      padStopSec: 0,
      segmentDurationSec: mediaDurationSec,
      startSec: input.introDurationSec + segmentStart,
    };
    applyCoverage(segment, segmentStart);
    segments.push(segment);
    cursor += segment.segmentDurationSec;
    if (targetEnd - cursor > SECONDS_EPSILON && assignmentIndex < plan.assignments.length - 1) {
      issues.push(warning('clip_short_borrowed_forward', '当前画面较短，未覆盖时段由下一画面提前承接', assignment.beatIds, clip.clipId));
    }
  }

  if (contentDurationSec - cursor > SECONDS_EPSILON) {
    let segment = segments.at(-1);
    let segmentStart = cursor;
    if (!segment) {
      const clip = [...clips].sort((left, right) => left.shotIndex - right.shotIndex || left.clipId.localeCompare(right.clipId))[0];
      const mediaDurationSec = Math.min(clip.clipDurationSec, input.maxClipSeconds, contentDurationSec);
      segmentStart = 0;
      segment = {
        order: 0, clipId: clip.clipId, clipPath: clip.videoPath, intendedBeatIds: [], coveredBeatIds: [], gapBeatIds: [],
        clipDurationSec: clip.clipDurationSec, mediaDurationSec,
        trimEndToSec: clip.clipDurationSec - mediaDurationSec > SECONDS_EPSILON ? mediaDurationSec : null,
        padStopSec: 0, segmentDurationSec: mediaDurationSec, startSec: input.introDurationSec,
      };
      segments.push(segment);
      cursor = mediaDurationSec;
    } else {
      segmentStart = segment.startSec - input.introDurationSec;
    }

    const remaining = Math.max(0, contentDurationSec - cursor);
    const unusedPhysical = Math.max(0, segment.clipDurationSec - segment.mediaDurationSec);
    const unusedUnderMax = Math.max(0, input.maxClipSeconds - segment.mediaDurationSec);
    const mediaExtension = Math.min(remaining, unusedPhysical, unusedUnderMax);
    segment.mediaDurationSec += mediaExtension;
    cursor += mediaExtension;
    const pad = Math.max(0, contentDurationSec - cursor);
    segment.padStopSec += pad;
    cursor += pad;
    segment.segmentDurationSec = segment.mediaDurationSec + segment.padStopSec;
    segment.trimEndToSec = segment.clipDurationSec - segment.mediaDurationSec > SECONDS_EPSILON ? segment.mediaDurationSec : null;
    applyCoverage(segment, segmentStart);
    if (segment.padStopSec > SECONDS_EPSILON) {
      issues.push(warning('last_clip_frozen', '最后画面已定格以覆盖完整口播', segment.coveredBeatIds, segment.clipId));
    }
    if (segment.segmentDurationSec - input.maxClipSeconds > SECONDS_EPSILON) {
      issues.push(warning('last_clip_exceeds_max_after_fallback', '末段兜底后超过单画面时长上限', segment.coveredBeatIds, segment.clipId));
    }
  }

  for (const gap of plan.gaps) {
    issues.push(warning('visual_gap', `画面缺口：${gap.reason}`, [gap.beatId], null));
  }
  const relativeDelta = Math.abs(totalDurationSec - input.targetDurationSec) / input.targetDurationSec;
  if (relativeDelta - input.durationTolerancePct > SECONDS_EPSILON) {
    issues.push(warning('target_duration_out_of_tolerance', '成片实际时长超出目标容差', [], null));
  }

  return { segments, issues, contentDurationSec, totalDurationSec };
}
