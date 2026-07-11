import type { ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineIssue } from './types.ts';

export type ArrangementValidationResult =
  | { ok: true; plan: ArrangementPlan }
  | { ok: false; issues: TimelineIssue[] };

const invalidIssue = (message: string, beatIds: string[] = [], clipId: string | null = null): TimelineIssue => ({
  code: 'arrangement_invalid', severity: 'error', message, beatIds, clipId,
});

/** Validate a human/AI arrangement against the current draft snapshots and return its normalized form. */
export function validateArrangement(
  plan: ArrangementPlan,
  beats: NarrationBeat[],
  clips: ClipPoolItem[],
  maxClipSeconds: number,
): ArrangementValidationResult {
  const fail = (message: string, beatIds: string[] = [], clipId: string | null = null): ArrangementValidationResult =>
    ({ ok: false, issues: [invalidIssue(message, beatIds, clipId)] });

  if (!Number.isFinite(maxClipSeconds) || maxClipSeconds <= 0) return fail('单画面时长上限必须是有限正数');
  const orderedBeats = [...beats].sort((a, b) => a.index - b.index);
  const beatPosition = new Map<string, number>();
  for (const [position, beat] of orderedBeats.entries()) {
    if (beatPosition.has(beat.beatId)) return fail('口播节拍编号重复', [beat.beatId]);
    if (!Number.isFinite(beat.durationSec) || beat.durationSec <= 0) return fail('口播节拍时长必须是有限正数', [beat.beatId]);
    beatPosition.set(beat.beatId, position);
  }

  const clipIds = new Set(clips.map((clip) => clip.clipId));
  const usedClips = new Set<string>();
  const coveredBeats = new Set<string>();
  let previousAssignmentEnd = -1;
  const assignments = [] as ArrangementPlan['assignments'];

  for (const assignment of plan.assignments) {
    if (!clipIds.has(assignment.clipId)) return fail(`素材不存在：${assignment.clipId}`, [], assignment.clipId);
    if (usedClips.has(assignment.clipId)) return fail(`素材被重复使用：${assignment.clipId}`, [], assignment.clipId);
    usedClips.add(assignment.clipId);
    if (assignment.beatIds.length === 0) return fail('每个编排片段至少需要一个口播节拍', [], assignment.clipId);

    const positions: number[] = [];
    let duration = 0;
    for (const beatId of assignment.beatIds) {
      const position = beatPosition.get(beatId);
      if (position === undefined) return fail(`口播节拍不存在：${beatId}`, [beatId], assignment.clipId);
      if (coveredBeats.has(beatId)) return fail(`口播节拍被重复使用：${beatId}`, [beatId], assignment.clipId);
      coveredBeats.add(beatId);
      positions.push(position);
      duration += orderedBeats[position].durationSec;
    }
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index] !== positions[index - 1] + 1) return fail('片段内口播节拍必须连续且升序', [...assignment.beatIds], assignment.clipId);
    }
    if (positions[0] <= previousAssignmentEnd) return fail('编排片段的口播节拍必须整体升序', [...assignment.beatIds], assignment.clipId);
    previousAssignmentEnd = positions.at(-1) as number;
    if (duration > maxClipSeconds) return fail('编排片段时长超过单画面时长上限', [...assignment.beatIds], assignment.clipId);
    assignments.push({ assignmentId: assignment.assignmentId, clipId: assignment.clipId, beatIds: [...assignment.beatIds] });
  }

  const gaps = [] as ArrangementPlan['gaps'];
  for (const gap of plan.gaps) {
    if (!beatPosition.has(gap.beatId)) return fail(`口播节拍不存在：${gap.beatId}`, [gap.beatId]);
    if (coveredBeats.has(gap.beatId)) return fail(`口播节拍被重复使用：${gap.beatId}`, [gap.beatId]);
    coveredBeats.add(gap.beatId);
    const reason = gap.reason.trim();
    if (!reason) return fail('画面缺口原因不能为空', [gap.beatId]);
    if (reason.length > 200) return fail('画面缺口原因不能超过 200 字', [gap.beatId]);
    gaps.push({ beatId: gap.beatId, reason });
  }

  if (coveredBeats.size !== beats.length) return fail('每个口播节拍必须且只能编排一次');
  return { ok: true, plan: { assignments, gaps } };
}

/** Preserve the PATCH route's exception-based 400 flow while sharing the pure validator. */
export function assertValidArrangement(
  plan: ArrangementPlan,
  beats: NarrationBeat[],
  clips: ClipPoolItem[],
  maxClipSeconds: number,
): ArrangementPlan {
  const result = validateArrangement(plan, beats, clips, maxClipSeconds);
  if (!result.ok) throw new Error(result.issues[0]?.message ?? '编排内容无效');
  return result.plan;
}

/** Build a deterministic, non-mutating arrangement when an AI plan cannot be used. */
export function buildFallbackArrangement(
  beats: NarrationBeat[],
  clips: ClipPoolItem[],
  maxClipSeconds: number,
): ArrangementPlan {
  const orderedBeats = [...beats].sort((a, b) => a.index - b.index);
  const orderedClips = [...clips].sort((a, b) => a.shotIndex - b.shotIndex);
  const assignments: ArrangementPlan['assignments'] = [];
  const gaps: ArrangementPlan['gaps'] = [];
  let beatIndex = 0;
  let clipIndex = 0;

  while (beatIndex < orderedBeats.length) {
    const current = orderedBeats[beatIndex];
    if (!Number.isFinite(current.durationSec) || current.durationSec <= 0 || current.durationSec > maxClipSeconds) {
      gaps.push({ beatId: current.beatId, reason: '口播节拍超过单画面时长限制' });
      beatIndex += 1;
      continue;
    }
    if (clipIndex >= orderedClips.length) {
      gaps.push({ beatId: current.beatId, reason: '没有足够的候选画面' });
      beatIndex += 1;
      continue;
    }

    const beatIds: string[] = [];
    let duration = 0;
    while (beatIndex < orderedBeats.length) {
      const candidate = orderedBeats[beatIndex];
      if (!Number.isFinite(candidate.durationSec) || candidate.durationSec <= 0 || candidate.durationSec > maxClipSeconds) break;
      if (duration + candidate.durationSec > maxClipSeconds) break;
      beatIds.push(candidate.beatId);
      duration += candidate.durationSec;
      beatIndex += 1;
    }
    assignments.push({ assignmentId: `fallback-${assignments.length}`, clipId: orderedClips[clipIndex].clipId, beatIds });
    clipIndex += 1;
  }

  return { assignments, gaps };
}
