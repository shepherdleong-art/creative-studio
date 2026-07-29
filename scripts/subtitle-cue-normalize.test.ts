import assert from 'node:assert/strict';
import {
  hasLegacyAutomaticSubtitleCuesToNormalize,
  normalizeLegacyAutomaticSubtitleCues,
} from '../lib/final-edit/subtitle-cue-normalize.ts';
import type { SubtitleCue } from '../lib/final-edit/types.ts';

const automatic: SubtitleCue = {
  id: 'automatic',
  segmentId: 'segment-1',
  text: '柔软 承托\u3000安心',
  startUs: 0,
  endUs: 1_000_000,
  textSource: 'script',
  timingSource: 'aligned',
};

assert.equal(hasLegacyAutomaticSubtitleCuesToNormalize([automatic]), true);

let nextId = 1;
const normalized = normalizeLegacyAutomaticSubtitleCues([automatic], () => `created-${nextId++}`);
assert.deepEqual(normalized, [
  { ...automatic, text: '柔软', endUs: 333_333, timingSource: 'proportional' },
  { ...automatic, id: 'created-1', text: '承托', startUs: 333_333, endUs: 666_667, timingSource: 'proportional' },
  { ...automatic, id: 'created-2', text: '安心', startUs: 666_667, timingSource: 'proportional' },
], '自动字幕必须按内容权重在 24fps 帧边界上拆分，并保留首段 ID');

const manualText: SubtitleCue = { ...automatic, id: 'manual-text', text: '人工 字幕', textSource: 'manual' };
const manualTiming: SubtitleCue = { ...automatic, id: 'manual-timing', text: '自动 文本', timingSource: 'manual' };
const manualSplit: SubtitleCue = { ...automatic, id: 'manual-split', text: '人工 拆分', textSource: 'manual', timingSource: 'manual' };
const englishSpacing: SubtitleCue = { ...automatic, id: 'english', text: 'OpenAI GPT 5 Pro' };
assert.equal(hasLegacyAutomaticSubtitleCuesToNormalize([manualText, manualTiming, manualSplit, englishSpacing]), false);
assert.deepEqual(
  normalizeLegacyAutomaticSubtitleCues([manualText, manualTiming, manualSplit, englishSpacing], () => 'unused'),
  [manualText, manualTiming, manualSplit, englishSpacing],
  '人工文字、人工时间、人工拆分及英文词间空格都必须保持原样',
);

const tooShort: SubtitleCue = { ...automatic, id: 'too-short', text: '一 二 三', endUs: 100_000 };
assert.equal(hasLegacyAutomaticSubtitleCuesToNormalize([tooShort]), false, '不足以给每段分配一帧时不应提示可规范化');
assert.deepEqual(
  normalizeLegacyAutomaticSubtitleCues([tooShort], () => 'unused'),
  [tooShort],
  '无法让每段至少占一帧时必须保留原 Cue',
);

const exactTwoFrameCue: SubtitleCue = { ...automatic, id: 'two-frames', text: '甲 乙', endUs: 83_333 };
assert.equal(hasLegacyAutomaticSubtitleCuesToNormalize([exactTwoFrameCue]), true, '舍入为 83333us 的两帧 Cue 必须可拆');
assert.deepEqual(
  normalizeLegacyAutomaticSubtitleCues([exactTwoFrameCue], () => 'two-frames-right'),
  [
    { ...exactTwoFrameCue, text: '甲', endUs: 41_667, timingSource: 'proportional' },
    { ...exactTwoFrameCue, id: 'two-frames-right', text: '乙', startUs: 41_667, timingSource: 'proportional' },
  ],
);

const halfFrameEdges: SubtitleCue = { ...automatic, id: 'half-frame-edges', text: '甲 乙', startUs: 20_833, endUs: 62_500 };
assert.equal(
  hasLegacyAutomaticSubtitleCuesToNormalize([halfFrameEdges]),
  false,
  '旧自动字幕的真实首尾不足一帧时不得因端点帧号四舍五入而拆分',
);

console.log('subtitle cue normalize tests passed');
