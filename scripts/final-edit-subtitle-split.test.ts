import assert from 'node:assert/strict';
import { planSubtitleCueSplit } from '../components/final-edit/subtitle-split.ts';
import type { SubtitleCue } from '../lib/final-edit/types.ts';

function cue(text: string, startUs = 0, endUs = 4_000_000): SubtitleCue {
  return {
    id: 'cue-1',
    segmentId: 'segment-1',
    text,
    startUs,
    endUs,
    textSource: 'manual',
    timingSource: 'manual',
  };
}

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('下班回到卧室 暖灯一开 先靠着床头'),
    requestedSplitUs: 2_400_000,
    fps: 10,
  }),
  {
    splitUs: 2_400_000,
    leftText: '下班回到卧室 暖灯一开',
    rightText: '先靠着床头',
  },
  '含硬空白时，文字必须匹配点击位置最近的空白边界',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('下班回到卧室　暖灯一开', 1_000_000, 3_000_000),
    requestedSplitUs: 2_040_000,
    fps: 10,
  }),
  {
    splitUs: 2_000_000,
    leftText: '下班回到卧室',
    rightText: '暖灯一开',
  },
  '全角空格是硬边界，时间必须量化到最近帧',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('柔软承托安心', 0, 3_000_000),
    requestedSplitUs: 1_000_000,
    fps: 10,
  }),
  {
    splitUs: 1_000_000,
    leftText: '柔软',
    rightText: '承托安心',
  },
  '没有硬空白时，按点击时间比例落到最近字符边界',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('Cloud Sofa 2.0', 0, 3_000_000),
    requestedSplitUs: 1_500_000,
    fps: 10,
  }),
  {
    splitUs: 1_500_000,
    leftText: 'Cloud S',
    rightText: 'ofa 2.0',
  },
  '英文词间空格不是硬句界，应回退为普通字符比例切分',
);

assert.equal(
  planSubtitleCueSplit({ cue: cue('不能贴边切'), requestedSplitUs: 20_000, fps: 10 }),
  null,
  '分割点任一侧不足一帧时必须拒绝',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('甲乙', 0, 1_000_000),
    requestedSplitUs: 500_000,
    fps: 24,
  }),
  { splitUs: 500_000, leftText: '甲', rightText: '乙' },
  '24fps 第 12 帧必须是精确 500000us，不能用 41667us 连乘得到 500004us',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('甲 乙', 0, 83_333),
    requestedSplitUs: 41_667,
    fps: 24,
  }),
  { splitUs: 41_667, leftText: '甲', rightText: '乙' },
  '由微秒舍入存储的两帧 Cue 必须允许在中间帧分割',
);

assert.deepEqual(
  planSubtitleCueSplit({
    cue: cue('甲 四四四四 五五五五五', 0, 166_667),
    requestedSplitUs: Math.round(166_667 * 0.31),
    fps: 24,
  }),
  { splitUs: 41_667, leftText: '甲 四四四四', rightText: '五五五五五' },
  '文字空白边界必须匹配原始点击比例，而不是量化后的时间比例',
);

assert.equal(
  planSubtitleCueSplit({
    cue: cue('甲乙', 20_833, 62_500),
    requestedSplitUs: 20_834,
    fps: 24,
  }),
  null,
  '非整帧 Cue 不能借端点四舍五入切出实际不足一帧的左右片段',
);

console.log('final-edit subtitle split tests passed');
