import type { ArrangementPlan, ClipPoolItem, NarrationBeat } from './types.ts';

/** Validate a human/AI arrangement against the current draft snapshots and return its normalized form. */
export function validateArrangement(
  plan: ArrangementPlan,
  beats: NarrationBeat[],
  clips: ClipPoolItem[],
  maxClipSeconds: number,
): ArrangementPlan {
  const orderedBeats = [...beats].sort((a, b) => a.index - b.index);
  const beatPosition = new Map(orderedBeats.map((beat, index) => [beat.beatId, index]));
  if (beatPosition.size !== beats.length) throw new Error('口播节拍编号重复');
  const clipIds = new Set(clips.map((clip) => clip.clipId));
  const usedClips = new Set<string>();
  const coveredBeats = new Set<string>();
  let previousAssignmentEnd = -1;

  const assignments = plan.assignments.map((assignment) => {
    if (!clipIds.has(assignment.clipId)) throw new Error(`素材不存在：${assignment.clipId}`);
    if (usedClips.has(assignment.clipId)) throw new Error(`素材被重复使用：${assignment.clipId}`);
    usedClips.add(assignment.clipId);
    if (assignment.beatIds.length === 0) throw new Error('每个编排片段至少需要一个口播节拍');

    const positions = assignment.beatIds.map((beatId) => {
      const position = beatPosition.get(beatId);
      if (position === undefined) throw new Error(`口播节拍不存在：${beatId}`);
      if (coveredBeats.has(beatId)) throw new Error(`口播节拍被重复使用：${beatId}`);
      coveredBeats.add(beatId);
      return position;
    });
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index] !== positions[index - 1] + 1) throw new Error('片段内口播节拍必须连续且升序');
    }
    if (positions[0] <= previousAssignmentEnd) throw new Error('编排片段的口播节拍必须整体升序');
    previousAssignmentEnd = positions.at(-1) as number;
    const duration = assignment.beatIds.reduce(
      (sum, beatId) => sum + orderedBeats[beatPosition.get(beatId) as number].durationSec,
      0,
    );
    if (duration > maxClipSeconds) throw new Error('编排片段时长超过单画面时长上限');
    return { assignmentId: assignment.assignmentId, clipId: assignment.clipId, beatIds: [...assignment.beatIds] };
  });

  const gaps = plan.gaps.map((gap) => {
    if (!beatPosition.has(gap.beatId)) throw new Error(`口播节拍不存在：${gap.beatId}`);
    if (coveredBeats.has(gap.beatId)) throw new Error(`口播节拍被重复使用：${gap.beatId}`);
    coveredBeats.add(gap.beatId);
    const reason = gap.reason.trim();
    if (!reason) throw new Error('画面缺口原因不能为空');
    if (reason.length > 200) throw new Error('画面缺口原因不能超过 200 字');
    return { beatId: gap.beatId, reason };
  });

  if (coveredBeats.size !== beats.length) throw new Error('每个口播节拍必须且只能编排一次');
  return { assignments, gaps };
}
