import assert from 'node:assert/strict';

const { calculateOverlapScore } = await import('../lib/final-edit/overlap.ts');
const { splitCoverTitle, timelineGaps } = await import('../lib/final-edit/domain.ts');
const { normalizeCoverPreset } = await import('../lib/final-edit/title-presets.ts');
const { defaultTextStyle } = await import('../lib/final-edit/domain.ts');
const { coverFramingGeometry, coverSafeAreaRect } = await import('../lib/final-edit/cover-framing.ts');

assert.deepEqual(splitCoverTitle('温柔包裹，慢享生活'), { primary: '温柔包裹', secondary: '慢享生活' });
assert.deepEqual(splitCoverTitle('舒适沙发'), { primary: '舒适', secondary: '沙发' });

assert.deepEqual(timelineGaps(100, [
  { timelineInFrame: 20, timelineOutFrame: 40 },
  { timelineInFrame: 0, timelineOutFrame: 10 },
  { timelineInFrame: 40, timelineOutFrame: 90 },
]), [{ startFrame: 10, endFrame: 20 }, { startFrame: 90, endFrame: 100 }]);

const score = calculateOverlapScore(
  { files: { a: 4, b: 2 }, sequence: ['a', 'b'], bgmKey: 'x', coverKey: 'one' },
  { files: { a: 2, c: 4 }, sequence: ['a', 'c'], bgmKey: 'x', coverKey: 'two' },
);
assert.equal(score.videoOverlap, 0.2);
assert.equal(score.orderSimilarity, 0.5);
assert.equal(score.score, 0.29);

const style = defaultTextStyle('coverPrimary', 1080);
const legacyPreset = Object.fromEntries(['3x4', '9x16', '16x9'].map((preset) => [preset, {
  coverPrimary: { ...style, text: '不得进入预设' },
  coverSecondary: { ...style, title: '也不得进入预设' },
}]));
const sanitized = normalizeCoverPreset(legacyPreset);
assert.equal(sanitized.version, 2);
assert.equal('text' in (sanitized.stylesByPreset['3x4'].primary as unknown as Record<string, unknown>), false);
assert.equal('title' in (sanitized.stylesByPreset['3x4'].secondary as unknown as Record<string, unknown>), false);
assert.deepEqual(sanitized.stylesByPreset['3x4'].framing, { scale: 1, offsetX: 0, offsetY: 0 }, 'V1 预设读取时必须补默认 framing');

const v2 = normalizeCoverPreset({ version: 2, stylesByPreset: Object.fromEntries(['3x4', '9x16', '16x9'].map((preset) => [preset, {
  primary: { ...style, italic: true },
  secondary: { ...style, italic: false, x: 0.62 },
  framing: { scale: 1.4, offsetX: 0.2, offsetY: -0.3 },
}])) });
assert.equal(v2.stylesByPreset['9x16'].primary.italic, true);
assert.equal(v2.stylesByPreset['9x16'].secondary.x, 0.62);
assert.deepEqual(v2.stylesByPreset['9x16'].framing, { scale: 1.4, offsetX: 0.2, offsetY: -0.3 });

assert.deepEqual(
  coverFramingGeometry({ sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1080, outputHeight: 1920, framing: { scale: 1, offsetX: 0, offsetY: 0 } }),
  { resizedWidth: 3414, resizedHeight: 1920, left: 1167, top: 0 },
  '9:16 封面预览与 renderer 必须共享同一整数裁切几何',
);
assert.deepEqual(coverSafeAreaRect(1080, 1920), { x: 43.2, y: 76.8, width: 993.6, height: 1766.4 });

console.log('final-edit domain tests passed');
