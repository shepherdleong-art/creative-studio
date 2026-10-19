import assert from 'node:assert/strict';
import { buildBatchNarrationSubtitleCues } from '../lib/batch-production/subtitle-cues.ts';
import type { BatchRenderNarrationSegment } from '../lib/batch-production/batch-renderer.ts';
import { countScriptContentCharacters } from '../lib/script-duration-policy.ts';

const segments: BatchRenderNarrationSegment[] = [
  { id: 'seg-1', sourceSegmentId: 'source-1', text: '大家好，今天给大家介绍一款特别好用的保温杯！', startUs: 0, endUs: 5_000_000 },
  { id: 'seg-2', sourceSegmentId: 'source-2', text: '它采用三层真空结构。保温长达十二小时。', startUs: 5_000_000, endUs: 12_000_000 },
  { id: 'seg-3', sourceSegmentId: 'source-3', text: '   ', startUs: 12_000_000, endUs: 13_000_000 },
  { id: 'seg-4', sourceSegmentId: 'source-4', text: '！！', startUs: 13_000_000, endUs: 14_000_000 },
  { id: 'seg-5', sourceSegmentId: 'source-5', text: '短句。', startUs: 14_000_000, endUs: 15_000_000 },
];

const cues = buildBatchNarrationSubtitleCues(segments);

// 多句段顺序保持:seg-1 与 seg-2 有 cue,空文本/纯标点句段整体跳过。
assert.equal(cues.length, 3 + 2 + 1);
assert.deepEqual(
  cues.map((cue) => cue.id),
  ['seg-1:cue:1', 'seg-1:cue:2', 'seg-1:cue:3', 'seg-2:cue:1', 'seg-2:cue:2', 'seg-5:cue:1'],
);
assert.deepEqual(cues.map((cue) => cue.sourceSegmentId), ['source-1', 'source-1', 'source-1', 'source-2', 'source-2', 'source-5']);

// 标点被清洗:任何 cue 文本不得带句读标点。
for (const cue of cues) {
  assert.ok(!/[。！？!?；;，,、：:]/u.test(cue.text), `cue 文本不得残留标点:${cue.text}`);
}
assert.equal(cues[0]?.text, '大家好');
assert.equal(cues[1]?.text, '今天给大家介绍一款特别好用的保温');
assert.equal(cues[2]?.text, '杯');
assert.equal(cues.at(-1)?.text, '短句');

// 每 cue ≤16 字(displayText 计)。
for (const cue of cues) {
  assert.ok(countScriptContentCharacters(cue.text) <= 16, `cue 超过 16 字:${cue.text}`);
}

// 窗口边界单调连续且不越出句段。
const windows: Record<string, { startUs: number; endUs: number }> = {
  'seg-1': { startUs: 0, endUs: 5_000_000 },
  'seg-2': { startUs: 5_000_000, endUs: 12_000_000 },
  'seg-5': { startUs: 14_000_000, endUs: 15_000_000 },
};
for (const [segmentId, window] of Object.entries(windows)) {
  const group = cues.filter((cue) => cue.id.startsWith(`${segmentId}:`));
  assert.ok(group.length > 0);
  assert.equal(group[0]?.startUs, window.startUs, `${segmentId} 首 cue 必须起于句段起点`);
  assert.equal(group.at(-1)?.endUs, window.endUs, `${segmentId} 末 cue 必须止于句段终点`);
  for (const cue of group) {
    assert.ok(cue.startUs >= window.startUs && cue.endUs <= window.endUs, `${cue.id} 越出句段窗口`);
    assert.ok(cue.endUs > cue.startUs, `${cue.id} 窗口必须为正`);
  }
  for (let index = 1; index < group.length; index += 1) {
    assert.equal(group[index]?.startUs, group[index - 1]?.endUs, `${segmentId} cue 窗口必须单调连续`);
  }
}

// 空输入与空文本句段。
assert.deepEqual(buildBatchNarrationSubtitleCues([]), []);
assert.deepEqual(
  buildBatchNarrationSubtitleCues([{ id: 'seg-x', sourceSegmentId: 'seg-x', text: '', startUs: 0, endUs: 1_000_000 }]),
  [],
);

console.log('batch subtitle cues tests passed');
