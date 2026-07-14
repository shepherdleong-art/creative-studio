import assert from 'node:assert/strict';
import { buildPlanArrangement } from '../lib/final-video/build-arrangement.ts';
import type { ClipPoolItem, NarrationBeat } from '../lib/final-video/types.ts';

const beat = (beatId: string, index: number, shotId: string, imageAssetId: string | null = null): NarrationBeat => ({
  beatId, index, text: beatId, subtitleText: beatId, shotId, imageAssetId,
  audioPath: `/tmp/${beatId}.m4a`, durationSec: 3, startSec: index * 3,
});
const clip = (clipId: string, shotId: string, shotIndex: number, sourceImageId = `i-${shotId}`): ClipPoolItem => ({
  clipId, shotId, shotIndex, videoPath: `/tmp/${clipId}.mp4`, clipDurationSec: 5,
  sourceImageId, sourceImagePath: `/tmp/${clipId}.png`,
});
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

// 素材齐全：每句拿到自己那张图，顺序 = 脚本顺序
{
  const beats = [beat('b0', 0, 's3'), beat('b1', 1, 's1')];
  const clips = [clip('c1', 's1', 1), clip('c2', 's2', 2), clip('c3', 's3', 3)];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s2'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c3', 'c1']);
  assert.deepEqual(plan.assignments.map((a) => a.beatIds), [['b0'], ['b1']]);
  assert.deepEqual(plan.gaps, []);
  assert.deepEqual(issues, []);
}

// 计划里的素材缺席 → 从备用池替补 + warning
{
  const beats = [beat('b0', 0, 's1'), beat('b1', 1, 's9')];   // s9 没视频
  const clips = [clip('c1', 's1', 1), clip('c2', 's2', 2)];   // s2 是备用
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s2'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1', 'c2']);
  assert.deepEqual(plan.gaps, []);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 素材缺席且备用池已空 → 该句进 gaps（由邻近画面覆盖），绝不失败
{
  const beats = [beat('b0', 0, 's1'), beat('b1', 1, 's9')];
  const clips = [clip('c1', 's1', 1)];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);
  assert.deepEqual(plan.gaps.map((g) => g.beatId), ['b1']);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 分镜图在写完脚本后被重生成过 → 软提醒，不阻断
{
  const beats = [beat('b0', 0, 's1', 'OLD-IMG')];
  const clips = [clip('c1', 's1', 1, 'NEW-IMG')];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);   // 照常出片
  assert.ok(codes(issues).includes('script_image_stale'));
}

// 旧脚本 imageAssetId 为 null → 不做过期检测，不告警
{
  const beats = [beat('b0', 0, 's1', null)];
  const clips = [clip('c1', 's1', 1, 'ANY')];
  const { issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.ok(!codes(issues).includes('script_image_stale'));
}

// 一张备用图只能替补一次（不能重复使用同一 clip）
{
  const beats = [beat('b0', 0, 's8'), beat('b1', 1, 's9')];
  const clips = [clip('c1', 's1', 1)];
  const { plan } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s1'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1']);
  assert.deepEqual(plan.gaps.map((g) => g.beatId), ['b1']);
}

// 脚本写完后才加进分镜组的新分镜（脚本没见过、也不在 droppedShots）也是备用素材
{
  const beats = [beat('b0', 0, 's1'), beat('b1', 1, 's9')];   // s9 没视频
  const clips = [clip('c1', 's1', 1), clip('c-new', 's-new', 7)];  // s-new 脚本没见过
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1', 'c-new']);
  assert.deepEqual(plan.gaps, []);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 旧格式脚本（droppedShotIds 恒为空）仍然有备用池，不会因缺素材就开天窗
{
  const beats = [beat('b0', 0, 's1', null), beat('b1', 1, 's9', null)];
  const clips = [clip('c1', 's1', 1), clip('c2', 's2', 2)];
  const { plan, issues } = buildPlanArrangement({ beats, clips, droppedShotIds: [] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c1', 'c2']);
  assert.deepEqual(plan.gaps, []);
  assert.ok(codes(issues).includes('planned_clip_substituted'));
}

// 替补优先级：脚本看过并丢弃的排在「脚本没见过的」前面，即使 shotIndex 更大
{
  const beats = [beat('b0', 0, 's9')];   // s9 没视频，必须替补
  const clips = [clip('c-new', 's-new', 1), clip('c-dropped', 's2', 5)];
  const { plan } = buildPlanArrangement({ beats, clips, droppedShotIds: ['s2'] });
  assert.deepEqual(plan.assignments.map((a) => a.clipId), ['c-dropped']);
}

console.log('final-video build-arrangement: OK');
