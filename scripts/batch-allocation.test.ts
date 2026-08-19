import assert from 'node:assert/strict';
import {
  allocateBatch,
  reallocateOutput,
  type FrozenBatchInput,
} from '../lib/batch-production/allocator.ts';

const baseInput: FrozenBatchInput = {
  projectId: 'project-1',
  batchId: 'batch-1',
  batchVersionId: 'version-1',
  ruleVersion: 'rules-v1',
  seed: 'seed-7',
  fps: 24,
  preset: 'vertical-1080x1920',
  targetDurationUs: 4_000_000,
  plans: [
    {
      planId: 'plan-a-1',
      scriptSnapshotId: 'script-a',
      title: '同一标题',
      segments: [
        { id: 'a-1', sourceSegmentId: 'source-a-1', text: '产品开场', startUs: 0, endUs: 2_000_000, semanticScores: { 'asset-a': 0.9, 'asset-b': 0.8, 'asset-c': 0.6 }, hookScores: { 'asset-a': 1 } },
        { id: 'a-2', text: '产品细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { 'asset-b': 0.9, 'asset-c': 0.7 } },
      ],
      musicTrackIds: ['music-1', 'music-2'],
    },
    {
      planId: 'plan-a-2',
      scriptSnapshotId: 'script-a',
      title: '同一标题',
      segments: [
        { id: 'a-1', text: '产品开场', startUs: 0, endUs: 2_000_000, semanticScores: { 'asset-a': 0.9, 'asset-b': 0.8, 'asset-c': 0.6 } },
        { id: 'a-2', text: '产品细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { 'asset-b': 0.9, 'asset-c': 0.7 } },
      ],
      musicTrackIds: ['music-1', 'music-2'],
    },
    {
      planId: 'plan-b-1',
      scriptSnapshotId: 'script-b',
      title: '另一标题',
      segments: [
        { id: 'b-1', text: '另一开场', startUs: 0, endUs: 2_000_000, semanticScores: { 'asset-c': 0.95, 'asset-b': 0.4 } },
        { id: 'b-2', text: '另一细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { 'asset-a': 0.8, 'asset-c': 0.5 } },
      ],
      musicTrackIds: ['music-1', 'music-2'],
    },
  ],
  assets: [
    { assetId: 'asset-a', contentFingerprint: 'sha256:a', durationUs: 8_000_000, analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }], coverFrameTimesUs: [500_000] } },
    { assetId: 'asset-b', contentFingerprint: 'sha256:b', durationUs: 8_000_000, analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 0.9 }], coverFrameTimesUs: [600_000] } },
    { assetId: 'asset-c', contentFingerprint: 'sha256:c', durationUs: 8_000_000, analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 0.8 }], coverFrameTimesUs: [700_000] } },
  ],
};

const first = allocateBatch(baseInput);
const second = allocateBatch(baseInput);
assert.deepEqual(second, first, '相同冻结输入、规则版本与 seed 必须完全确定');
assert.equal(first.outputs.length, 3);
assert.equal(first.summary.planCount, 3);
assert.ok(first.outputs.every((output) => output.arrangement.clips.length === 2));
assert.ok(first.outputs.every((output) => output.arrangement.clips.every((clip) => clip.clipId && clip.segmentId && clip.assetId)));
assert.ok(first.outputs.every((output) => output.arrangement.clips.every((clip) => clip.contentFingerprint)));
assert.ok(first.outputs.every((output) => output.arrangement.clips.every((clip) => clip.sourceEndUs > clip.sourceStartUs && clip.timelineEndUs > clip.timelineStartUs)));
assert.ok(first.outputs.every((output) => output.arrangement.narration.ready === false && output.arrangement.narration.productionReady === false));
assert.ok(first.outputs.every((output) => output.arrangement.subtitle.ready === true));
assert.ok(first.outputs.every((output) => output.arrangement.subtitle.productionReady === false));
assert.ok(first.outputs.every((output) => output.arrangement.subtitle.cues.length === 2));
assert.equal(first.outputs[0]?.arrangement.subtitle.cues[0]?.text, '产品开场');
assert.equal(first.outputs[0]?.arrangement.clips[0]?.sourceSegmentId, 'source-a-1');
assert.equal(first.outputs[0]?.title, first.outputs[1]?.title, '同一脚本多份不得自动修改标题');

const globalMusicInput = {
  ...baseInput,
  plans: baseInput.plans!.map((plan) => ({ ...plan, musicTrackIds: [] })),
  musicTrackIds: ['global-music-1'],
};
const globalMusicFirst = allocateBatch(globalMusicInput);
const globalMusicChanged = allocateBatch({ ...globalMusicInput, musicTrackIds: ['global-music-2'] });
assert.notEqual(globalMusicChanged.inputFingerprint, globalMusicFirst.inputFingerprint, '全局音乐冻结输入必须参与幂等身份');
assert.ok(globalMusicFirst.outputs.every((output) => output.arrangement.music.trackId === 'global-music-1'));
assert.ok(globalMusicChanged.outputs.every((output) => output.arrangement.music.trackId === 'global-music-2'));

const excluded = allocateBatch({ ...baseInput, excludedAssetIds: ['asset-c'] });
assert.ok(excluded.outputs.every((output) => output.arrangement.clips.every((clip) => clip.assetId !== 'asset-c')));
const excludedWithReason = allocateBatch({
  ...baseInput,
  exclusions: [{ assetId: 'asset-c', reason: '用户判断画面不适合' }],
});
assert.deepEqual(excludedWithReason.exclusions, [{ assetId: 'asset-c', reason: '用户判断画面不适合' }]);
assert.notEqual(
  allocateBatch({ ...baseInput, exclusions: [{ assetId: 'asset-c', reason: '原片暂时离线' }] }).inputFingerprint,
  excludedWithReason.inputFingerprint,
  '排除原因属于可审计冻结输入身份',
);

const globalChoice = allocateBatch({
  projectId: 'project-global', batchId: 'batch-global', batchVersionId: 'version-global', seed: 'global-optimum',
  plans: [
    { planId: 'plan-a', segments: [{ id: 'a', startUs: 0, endUs: 1_000_000, semanticScores: { x: 0.99, y: 0.8 } }] },
    { planId: 'plan-b', segments: [{ id: 'b', startUs: 0, endUs: 1_000_000, semanticScores: { x: 0.98, y: 0.1 } }] },
  ],
  assets: [
    { assetId: 'x', contentFingerprint: 'sha256:x', durationUs: 1_000_000, usableRanges: [{ startUs: 0, endUs: 1_000_000, qualityScore: 1 }] },
    { assetId: 'y', contentFingerprint: 'sha256:y', durationUs: 1_000_000, usableRanges: [{ startUs: 0, endUs: 1_000_000, qualityScore: 1 }] },
  ],
});
assert.equal(globalChoice.outputs.find(({ planId }) => planId === 'plan-a')?.arrangement.clips[0]?.assetId, 'y');
assert.equal(globalChoice.outputs.find(({ planId }) => planId === 'plan-b')?.arrangement.clips[0]?.assetId, 'x');

const locked = allocateBatch({
  ...baseInput,
  lockedSegments: [{ planId: 'plan-a-1', segmentId: 'a-1', assetId: 'asset-c', sourceStartUs: 1_000_000, sourceEndUs: 3_000_000 }],
});
const lockedClip = locked.outputs.find((output) => output.planId === 'plan-a-1')?.arrangement.clips[0];
assert.equal(lockedClip?.locked, true);
assert.equal(lockedClip?.assetId, 'asset-c');
assert.equal(lockedClip?.reason, 'manual_lock');
assert.equal(locked.outputs.find((output) => output.planId === 'plan-a-2')?.status, 'available', '单条锁定不能拖垮其他计划');

const conflicting = allocateBatch({
  ...baseInput,
  excludedAssetIds: ['asset-c'],
  lockedSegments: [{ planId: 'plan-a-1', segmentId: 'a-1', assetId: 'asset-c', sourceStartUs: 1_000_000, sourceEndUs: 3_000_000 }],
});
assert.equal(conflicting.outputs.find((output) => output.planId === 'plan-a-1')?.status, 'blocked');
assert.equal(conflicting.outputs.find((output) => output.planId === 'plan-a-2')?.status, 'available');

const reallocated = reallocateOutput(baseInput, first, 'plan-a-1', '换一种开场');
assert.equal(reallocated.outputs.length, 3);
assert.deepEqual(
  reallocated.outputs.filter((output) => output.planId !== 'plan-a-1').map((output) => output.arrangement),
  first.outputs.filter((output) => output.planId !== 'plan-a-1').map((output) => output.arrangement),
  '单条重分配必须固定其他计划',
);
assert.ok(reallocated.outputs.some((output) => output.planId === 'plan-a-1'));

// 「换一批画面」必须真正换画面:素材池有替代时,重分配避开当前版本用过的素材与封面。
const firstTargetClips = first.outputs.find((output) => output.planId === 'plan-a-1')!.arrangement.clips;
const firstTargetAssetIds = new Set(firstTargetClips.map((clip) => clip.assetId));
const reallocatedTarget = reallocated.outputs.find((output) => output.planId === 'plan-a-1')!;
assert.ok(reallocatedTarget.arrangement.clips.length > 0);
assert.ok(
  reallocatedTarget.arrangement.clips.every((clip) => !firstTargetAssetIds.has(clip.assetId)),
  '素材池有替代时,换一批画面必须避开当前版本用过的素材',
);
assert.ok(
  reallocatedTarget.arrangement.cover.assetId === null || !firstTargetAssetIds.has(reallocatedTarget.arrangement.cover.assetId),
  '换一批画面时封面同样避开当前版本素材',
);
// 再次换一批以上一版为基准避让:素材集合必须继续变化(在 a/b 与 c 之间轮转)。
// 注意:不传历史版本时只避让当前版本,连续两次会轮换回第一批——
// 真实持久化链路(allocation-store)总是传入历史版本,避免这种来回切换。
const reallocatedAgain = reallocateOutput(baseInput, reallocated, 'plan-a-1', '再换一次');
const reallocatedAgainTarget = reallocatedAgain.outputs.find((output) => output.planId === 'plan-a-1')!;
const reallocatedAssetIds = new Set(reallocatedTarget.arrangement.clips.map((clip) => clip.assetId));
assert.ok(
  reallocatedAgainTarget.arrangement.clips.every((clip) => !reallocatedAssetIds.has(clip.assetId)),
  '连续换一批画面必须持续避开上一批素材',
);

// 传入历史版本时避让集覆盖历史所有版本(素材+封面):连续换一批不会在
// 两批画面之间来回切换,直到素材池耗尽才回退复用。
const historyInput: FrozenBatchInput = {
  projectId: 'project-hist',
  batchId: 'batch-hist',
  batchVersionId: 'version-hist',
  ruleVersion: 'rules-v1',
  seed: 'seed-hist',
  fps: 24,
  preset: 'vertical-1080x1920',
  targetDurationUs: 4_000_000,
  plans: [
    {
      planId: 'plan-h-1',
      scriptSnapshotId: 'script-h',
      title: '历史避让',
      segments: [
        { id: 'h-1', text: '开场', startUs: 0, endUs: 2_000_000, semanticScores: { 'hist-a': 0.95, 'hist-c': 0.9, 'hist-e': 0.85, 'hist-b': 0.4, 'hist-d': 0.4, 'hist-f': 0.4 } },
        { id: 'h-2', text: '细节', startUs: 2_000_000, endUs: 4_000_000, semanticScores: { 'hist-b': 0.95, 'hist-d': 0.9, 'hist-f': 0.85, 'hist-a': 0.4, 'hist-c': 0.4, 'hist-e': 0.4 } },
      ],
      musicTrackIds: ['music-1'],
    },
  ],
  assets: ['hist-a', 'hist-b', 'hist-c', 'hist-d', 'hist-e', 'hist-f'].map((assetId, index) => ({
    assetId,
    contentFingerprint: `sha256:${assetId}`,
    durationUs: 8_000_000,
    analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }], coverFrameTimesUs: [500_000 + index * 100_000] },
  })),
};
const historyFirst = allocateBatch(historyInput);
const historyFirstTarget = historyFirst.outputs.find((output) => output.planId === 'plan-h-1')!;
assert.deepEqual(
  historyFirstTarget.arrangement.clips.map((clip) => clip.assetId),
  ['hist-a', 'hist-b'],
  '初始分配按语义分取最优素材',
);
const historySecond = reallocateOutput(historyInput, historyFirst, 'plan-h-1', '第一次换');
const historySecondTarget = historySecond.outputs.find((output) => output.planId === 'plan-h-1')!;
assert.deepEqual(
  historySecondTarget.arrangement.clips.map((clip) => clip.assetId),
  ['hist-c', 'hist-d'],
  '第一次换一批避开初始素材',
);
// 不传历史:避让集只有上一版,确定性轮换回第一批素材(遗留行为,仅作对照)。
const pingPong = reallocateOutput(historyInput, historySecond, 'plan-h-1', '第二次换');
assert.deepEqual(
  pingPong.outputs.find((output) => output.planId === 'plan-h-1')!.arrangement.clips.map((clip) => clip.assetId),
  ['hist-a', 'hist-b'],
  '不传历史版本时只避让当前版本,会轮换回第一批(对照组)',
);
// 传入历史:避让集覆盖两批旧素材,必须选出从未用过的素材,封面也不能重复。
const historyThird = reallocateOutput(
  historyInput,
  historySecond,
  'plan-h-1',
  '第二次换',
  [historyFirstTarget.arrangement, historySecondTarget.arrangement],
);
const historyThirdTarget = historyThird.outputs.find((output) => output.planId === 'plan-h-1')!;
assert.deepEqual(
  historyThirdTarget.arrangement.clips.map((clip) => clip.assetId),
  ['hist-e', 'hist-f'],
  '传入历史版本后,换一批必须避开所有历史素材,不再来回切换',
);
const historyCovers = [historyFirstTarget, historySecondTarget, historyThirdTarget].map((output) => output.arrangement.cover.assetId);
assert.equal(new Set(historyCovers).size, 3, '换一批画面时封面同样逐次避开历史封面素材');

console.log('batch allocation tests passed');
