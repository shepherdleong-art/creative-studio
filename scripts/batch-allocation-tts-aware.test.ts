import assert from 'node:assert/strict';
import { allocateBatch, type FrozenBatchInput } from '../lib/batch-production/allocator.ts';

const BODY = '周末午后，她窝在洒满阳光的客厅沙发里。坐着看书、贵妃位放腿，俩人并排躺也自在。软靠背和云座包稳稳托住身体，放松到不想起身。';
const ALIGNED = [
  { startUs: 0, endUs: 4_060_000 },
  { startUs: 4_060_000, endUs: 8_310_000 },
  { startUs: 8_310_000, endUs: 13_370_000 },
];
// 词级时间戳:词边界落在句子内部(自然断句处),供 TTS 感知再切分取边界。
const WORD_TIMINGS = [
  { text: '周末午后，', startUs: 0, endUs: 1_350_000 },
  { text: '她窝在洒满阳光的客厅沙发里', startUs: 1_350_000, endUs: 2_720_000 },
  { text: '。', startUs: 2_720_000, endUs: 4_060_000 },
  { text: '坐着看书、', startUs: 4_060_000, endUs: 5_500_000 },
  { text: '贵妃位放腿，', startUs: 5_500_000, endUs: 6_900_000 },
  { text: '俩人并排躺也自在。', startUs: 6_900_000, endUs: 8_310_000 },
  { text: '软靠背和云座包稳稳托住身体，', startUs: 8_310_000, endUs: 9_900_000 },
  { text: '放松到不想起身。', startUs: 9_900_000, endUs: 11_100_000 },
  { text: '。', startUs: 11_100_000, endUs: 13_370_000 },
];

// 一批 3 秒场景:3 个素材 × 3 段 = 9 个场景,单元数上限按场景数取 min(8, 9) = 8
function makeAssets(): FrozenBatchInput['assets'] {
  return ['a', 'b', 'c'].map((letter) => ({
    assetId: `asset-${letter}`,
    contentFingerprint: `sha256:${letter.repeat(64)}`,
    analysisId: `an-${letter}`,
    analysisJson: {
      durationUs: 9_000_000,
      usableRanges: [
        { startUs: 0, endUs: 3_000_000, qualityScore: 1 },
        { startUs: 3_000_000, endUs: 6_000_000, qualityScore: 1 },
        { startUs: 6_000_000, endUs: 9_000_000, qualityScore: 1 },
      ],
    },
  }));
}

function makeInput(withWordTimings: boolean): FrozenBatchInput {
  return {
    projectId: 'p',
    batchId: 'b',
    batchVersionId: 'v',
    fps: 24,
    preset: '3:4',
    targetDurationSec: 15,
    plans: [
      {
        planId: 'plan-1',
        scriptSnapshotId: 's1',
        title: 'G564',
        bodyText: BODY,
        scriptSnapshot: { targetDurationSec: 15 },
        narration: {
          durationUs: 13_370_000,
          audioFingerprint: 'sha256:' + 'c'.repeat(64),
          segments: ALIGNED.map((timing, index) => ({
            id: `nar-${index + 1}`,
            sourceSegmentId: `nar-${index + 1}`,
            text: `句${index + 1}`,
            ...timing,
          })),
          ...(withWordTimings ? { wordTimings: WORD_TIMINGS } : {}),
        },
      },
    ],
    assets: makeAssets(),
  };
}

try {
  // 3. 无词级时间戳:退回 1 句 1 镜头,不抛错;同时取得原句 id 全集。
  // 场景需能整段装下整句(3 秒场景会走句段内拼接,与本卡无关)。
  const legacy = allocateBatch({
    ...makeInput(false),
    assets: ['a'].map((letter) => ({
      assetId: `asset-${letter}`,
      contentFingerprint: `sha256:${letter.repeat(64)}`,
      analysisId: `an-${letter}`,
      analysisJson: { durationUs: 15_000_000, usableRanges: [{ startUs: 0, endUs: 15_000_000, qualityScore: 1 }] },
    })),
  });
  const legacyArrangement = legacy.outputs[0]!.arrangement;
  assert.equal(legacyArrangement.clips.length, 3, '无词级时间戳必须退回整句');
  assert.deepEqual(
    legacyArrangement.clips.map((clip) => [clip.timelineStartUs, clip.timelineEndUs]),
    ALIGNED.map((timing) => [timing.startUs, timing.endUs]),
  );
  const originalSegmentIds = new Set(legacyArrangement.clips.map((clip) => clip.segmentId));

  // 1. 有词级时间戳:单元数 > 句数且 ≤ 8;边界落在词边界上;sourceSegmentId 仍是原句 id
  const result = allocateBatch(makeInput(true));
  const arrangement = result.outputs[0]!.arrangement;
  const unitCount = arrangement.clips.length;
  assert.ok(unitCount > 3, `长句必须被再切分(实际 ${unitCount} 个单元)`);
  assert.ok(unitCount <= 8, `单元数不得超过 8(实际 ${unitCount})`);
  const wordEnds = new Set(WORD_TIMINGS.map((word) => word.endUs));
  for (const clip of arrangement.clips) {
    assert.ok(
      clip.timelineStartUs === 0 || wordEnds.has(clip.timelineStartUs),
      `单元起点 ${clip.timelineStartUs} 必须落在词边界上`,
    );
    assert.ok(
      clip.timelineEndUs === 13_370_000 || wordEnds.has(clip.timelineEndUs),
      `单元终点 ${clip.timelineEndUs} 必须落在词边界上`,
    );
    assert.ok(
      originalSegmentIds.has(clip.sourceSegmentId),
      `sourceSegmentId 必须是原句 id(实际 ${clip.sourceSegmentId})`,
    );
    assert.ok(
      clip.segmentId.includes(':unit:'),
      `单元 segmentId 必须带 :unit: 身份(实际 ${clip.segmentId})`,
    );
  }
  // 时间线连续且总长等于口播时长
  const sorted = [...arrangement.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  for (let index = 0; index < sorted.length; index += 1) {
    if (index === 0) assert.equal(sorted[index].timelineStartUs, 0);
    else assert.equal(sorted[index].timelineStartUs, sorted[index - 1].timelineEndUs, '单元时间线必须连续');
  }
  assert.equal(sorted.at(-1)!.timelineEndUs, 13_370_000);

  // 2. 字幕按整句切一次:cue 的 sourceSegmentId 只有 3 个原句,不随单元数膨胀
  const cueSources = new Set(arrangement.subtitle.cues.map((cue) => cue.sourceSegmentId));
  assert.deepEqual([...cueSources].sort(), [...originalSegmentIds].sort(), '字幕 cue 必须仍按整句(3 个来源)切分');
  assert.equal(
    arrangement.subtitle.cues.length,
    legacyArrangement.subtitle.cues.length,
    '单元拆分不得让字幕 cue 数随镜头数膨胀(按整句切一次)',
  );

  console.log('batch allocation tts-aware tests passed');
} finally {
  // 无全局状态需要清理
}
