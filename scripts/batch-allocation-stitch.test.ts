import assert from 'node:assert/strict';
import {
  allocateBatch,
  type FrozenBatchInput,
} from '../lib/batch-production/allocator.ts';
import { normalizeAutomaticSubtitleText, splitNarrationForDisplay } from '../lib/subtitle-display.ts';

// 真实案例最小化:脚本 2 句 × 7.5s(targetDurationSec 15 均摊),
// 素材池单场景最长 5.3s,任何单区间都装不下一个句段,必须句段内拼接。
const stitchInput: FrozenBatchInput = {
  projectId: 'project-stitch',
  batchId: 'batch-stitch',
  batchVersionId: 'version-stitch',
  seed: 'seed-stitch',
  fps: 24,
  preset: 'vertical-1080x1920',
  targetDurationSec: 15,
  plans: [
    {
      planId: 'plan-stitch-1',
      scriptSnapshotId: 'script-stitch',
      title: '拼接脚本',
      script: { targetDurationSec: 15 },
      segments: [
        { id: 'seg-1', text: '第一句开场介绍产品', startUs: 0, endUs: 7_500_000, semanticScores: { 'asset-a': 0.9, 'asset-b': 0.7, 'asset-c': 0.5 } },
        { id: 'seg-2', text: '第二句继续讲细节这里还有很多很多内容要说清楚', startUs: 7_500_000, endUs: 15_000_000, semanticScores: { 'asset-b': 0.8, 'asset-c': 0.7, 'asset-a': 0.4 } },
      ],
    },
  ],
  assets: [
    { assetId: 'asset-a', contentFingerprint: 'sha256:a', durationUs: 5_300_000, analysisJson: { durationUs: 5_300_000, usableRanges: [{ startUs: 0, endUs: 5_300_000, qualityScore: 0.9 }], coverFrameTimesUs: [500_000] } },
    { assetId: 'asset-b', contentFingerprint: 'sha256:b', durationUs: 4_000_000, analysisJson: { durationUs: 4_000_000, usableRanges: [{ startUs: 0, endUs: 4_000_000, qualityScore: 0.8 }], coverFrameTimesUs: [400_000] } },
    { assetId: 'asset-c', contentFingerprint: 'sha256:c', durationUs: 3_000_000, analysisJson: { durationUs: 3_000_000, usableRanges: [{ startUs: 0, endUs: 3_000_000, qualityScore: 0.7 }], coverFrameTimesUs: [300_000] } },
  ],
};

const stitched = allocateBatch(stitchInput);
const stitchedOutput = stitched.outputs.find((output) => output.planId === 'plan-stitch-1');
assert.ok(stitchedOutput, '拼接用例必须产出 plan-stitch-1');
assert.equal(stitchedOutput.status, 'available', '单场景装不下句段时必须用多镜头拼接兜底,不得 no-legal-media');
assert.deepEqual(stitchedOutput.blockers, []);

const stitchedClips = stitchedOutput.arrangement.clips;
const segmentOneClips = stitchedClips.filter((clip) => clip.segmentId === 'seg-1');
const segmentTwoClips = stitchedClips.filter((clip) => clip.segmentId === 'seg-2');
assert.ok(segmentOneClips.length >= 2, `句段 1 必须拼出至少 2 个 chunk clip,实际 ${segmentOneClips.length}`);
assert.ok(segmentTwoClips.length >= 2, `句段 2 必须拼出至少 2 个 chunk clip,实际 ${segmentTwoClips.length}`);
assert.ok(stitchedClips.every((clip) => clip.reason === 'semantic_stitch_fallback'), '拼接 chunk 必须使用独立 reason 词');
assert.ok(segmentOneClips.every((clip, index) => clip.clipId === `plan-stitch-1:clip:seg-1:part:${index + 1}`), 'chunk clipId 必须按 part 序号命名');
assert.ok(stitchedClips.every((clip) => clip.sourceEndUs > clip.sourceStartUs && clip.timelineEndUs > clip.timelineStartUs));

// 整条 timeline 0→15s 无洞无叠。
assert.equal(stitchedClips[0]?.timelineStartUs, 0);
assert.equal(stitchedClips.at(-1)?.timelineEndUs, 15_000_000);
for (let index = 1; index < stitchedClips.length; index += 1) {
  assert.equal(
    stitchedClips[index]?.timelineStartUs,
    stitchedClips[index - 1]?.timelineEndUs,
    `clip ${index} 的时间线必须紧贴前一个 clip`,
  );
}
assert.equal(
  stitchedClips.reduce((sum, clip) => sum + (clip.timelineEndUs - clip.timelineStartUs), 0),
  15_000_000,
);
assert.ok(stitchedOutput.warnings.includes('stitched-segment:seg-1'));
assert.ok(stitchedOutput.warnings.includes('stitched-segment:seg-2'));

// 确定性:同输入两次分配深比较全等。
assert.deepEqual(allocateBatch(stitchInput), stitched, '拼接路径必须与主路径一样完全确定');

// 字幕 cue:按句段分组,拼接段的 cue 覆盖整段窗口且不重复整句文本。
const stitchedCues = stitchedOutput.arrangement.subtitle.cues;
const segmentOneText = '第一句开场介绍产品';
const segmentTwoText = '第二句继续讲细节这里还有很多很多内容要说清楚';
const segmentOneCues = stitchedCues.filter((cue) => cue.sourceSegmentId === 'seg-1');
const segmentTwoCues = stitchedCues.filter((cue) => cue.sourceSegmentId === 'seg-2');
assert.equal(segmentOneCues.length, splitNarrationForDisplay(segmentOneText, { maxContentCharacters: 16 }).length, '拼接句段只按整句切一次 cue,不按 chunk 重复');
assert.equal(segmentTwoCues.length, splitNarrationForDisplay(segmentTwoText, { maxContentCharacters: 16 }).length);
assert.equal(segmentOneCues[0]?.startUs, 0);
assert.equal(segmentOneCues.at(-1)?.endUs, 7_500_000);
assert.equal(segmentTwoCues[0]?.startUs, 7_500_000);
assert.equal(segmentTwoCues.at(-1)?.endUs, 15_000_000);
for (const cues of [segmentOneCues, segmentTwoCues]) {
  for (let index = 1; index < cues.length; index += 1) {
    assert.equal(cues[index]?.startUs, cues[index - 1]?.endUs, '同一句段内的 cue 窗口必须单调连续');
  }
}
const stripWhitespace = (value: string) => value.replace(/\s+/gu, '');
assert.equal(
  segmentTwoCues.map((cue) => cue.text).join(''),
  stripWhitespace(normalizeAutomaticSubtitleText(segmentTwoText)),
  '拼接段全部 cue 拼起来必须恰好是整句一次,不得按 chunk 重复整句',
);

// 素材池全空:仍保留 no-legal-media blocker。
const emptyPool = allocateBatch({ ...stitchInput, assets: [] });
const emptyOutput = emptyPool.outputs.find((output) => output.planId === 'plan-stitch-1');
assert.equal(emptyOutput?.status, 'blocked');
assert.ok(emptyOutput?.blockers.includes('no-legal-media:seg-1'));

// 单区间可行的输入走主路径:不产生 chunk clip,reason 与 clipId 保持原样。
const mainPath = allocateBatch({
  projectId: 'project-main',
  batchId: 'batch-main',
  batchVersionId: 'version-main',
  seed: 'seed-main',
  fps: 24,
  preset: 'vertical-1080x1920',
  targetDurationUs: 2_000_000,
  plans: [
    {
      planId: 'plan-main',
      segments: [
        { id: 'seg-1', text: '短句', startUs: 0, endUs: 2_000_000, semanticScores: { 'asset-a': 0.9 } },
      ],
    },
  ],
  assets: [
    { assetId: 'asset-a', contentFingerprint: 'sha256:a', durationUs: 8_000_000, analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }], coverFrameTimesUs: [500_000] } },
  ],
});
const mainOutput = mainPath.outputs.find((output) => output.planId === 'plan-main');
assert.equal(mainOutput?.status, 'available');
assert.equal(mainOutput?.arrangement.clips.length, 1);
assert.equal(mainOutput?.arrangement.clips[0]?.reason, 'semantic_primary');
assert.equal(mainOutput?.arrangement.clips[0]?.clipId, 'plan-main:clip:seg-1');
assert.ok(!mainOutput?.warnings.some((warning) => warning.startsWith('stitched-segment:')));
assert.equal(mainOutput?.arrangement.subtitle.cues.length, 1);
assert.equal(mainOutput?.arrangement.subtitle.cues[0]?.startUs, 0);
assert.equal(mainOutput?.arrangement.subtitle.cues[0]?.endUs, 2_000_000);

console.log('batch allocation stitch tests passed');
