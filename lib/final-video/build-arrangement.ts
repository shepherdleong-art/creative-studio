// lib/final-video/build-arrangement.ts
/**
 * 把脚本的计划（beat.shotId）变成 solver 吃的 ArrangementPlan。**确定性，不调 LLM。**
 *
 * 铁律：顺序是计划不是合同。
 * - 计划里的素材缺席（视频没生成/失败）→ 从备用池（脚本没选中的分镜）替补 + warning。
 * - 备用池也空了 → 该 beat 进 gaps；solve-timeline 会让邻近画面提前顶上并报 visual_gap。
 * - 分镜图在脚本写完后被重生成过 → 只发 warning，绝不阻断出片。
 */
import type { ArrangementPlan, ClipPoolItem, NarrationBeat, TimelineIssue } from './types.ts';

const warning = (
  code: TimelineIssue['code'],
  message: string,
  beatIds: string[],
  clipId: string | null,
): TimelineIssue => ({ code, severity: 'warning', message, beatIds, clipId });

export function buildPlanArrangement(input: {
  beats: NarrationBeat[];
  clips: ClipPoolItem[];
  droppedShotIds: string[];
}): { plan: ArrangementPlan; issues: TimelineIssue[] } {
  const beats = [...input.beats].sort((a, b) => a.index - b.index);
  const clipByShotId = new Map(input.clips.map((clip) => [clip.shotId, clip]));

  // 备用池 = 脚本明确丢弃的分镜里、确实有可用视频的那些。按 shotIndex 稳定排序，
  // 让替补结果可复现（同一草稿反复 prepare 得到同一条片子）。
  const droppedSet = new Set(input.droppedShotIds);
  const spares = input.clips
    .filter((clip) => droppedSet.has(clip.shotId))
    .sort((a, b) => a.shotIndex - b.shotIndex || a.clipId.localeCompare(b.clipId));

  const usedClipIds = new Set<string>();
  const assignments: ArrangementPlan['assignments'] = [];
  const gaps: ArrangementPlan['gaps'] = [];
  const issues: TimelineIssue[] = [];

  const takeSpare = (): ClipPoolItem | undefined =>
    spares.find((clip) => !usedClipIds.has(clip.clipId));

  for (const beat of beats) {
    const planned = clipByShotId.get(beat.shotId);

    if (planned && !usedClipIds.has(planned.clipId)) {
      // 脚本看的那张图，和这条视频实际用的那张源图不是同一张 —— 说明分镜图在写完脚本后被重生成过。
      // 多数情况只是画质微调、主体一致，脚本仍然有效，所以只提醒，不阻断。
      if (beat.imageAssetId && beat.imageAssetId !== planned.sourceImageId) {
        issues.push(warning(
          'script_image_stale',
          '分镜图在脚本生成后被重新生成过，文案可能与画面不匹配',
          [beat.beatId],
          planned.clipId,
        ));
      }
      usedClipIds.add(planned.clipId);
      assignments.push({ assignmentId: `plan-${assignments.length}`, clipId: planned.clipId, beatIds: [beat.beatId] });
      continue;
    }

    const spare = takeSpare();
    if (spare) {
      usedClipIds.add(spare.clipId);
      assignments.push({ assignmentId: `plan-${assignments.length}`, clipId: spare.clipId, beatIds: [beat.beatId] });
      issues.push(warning(
        'planned_clip_substituted',
        '计划中的画面缺失，已用备用画面替补',
        [beat.beatId],
        spare.clipId,
      ));
      continue;
    }

    // 无图可用：交给 solver 的 gap 机制 —— 邻近画面会提前顶上，成片不会开天窗。
    gaps.push({ beatId: beat.beatId, reason: '计划中的画面缺失，且备用池已空' });
    issues.push(warning(
      'planned_clip_substituted',
      '计划中的画面缺失，且没有备用画面可替补',
      [beat.beatId],
      null,
    ));
  }

  return { plan: { assignments, gaps }, issues };
}
