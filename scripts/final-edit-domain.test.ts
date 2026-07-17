import assert from 'node:assert/strict';

const { calculateOverlapScore } = await import('../lib/final-edit/overlap.ts');
const { splitCoverTitle, timelineGaps } = await import('../lib/final-edit/domain.ts');
const { sanitizeTitlePresetStyles } = await import('../lib/final-edit/title-presets.ts');
const { defaultTextStyle } = await import('../lib/final-edit/domain.ts');

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
const sanitized = sanitizeTitlePresetStyles(Object.fromEntries(['3x4', '9x16', '16x9'].map((preset) => [preset, {
  coverPrimary: { ...style, text: '不得进入预设' },
  coverSecondary: { ...style, title: '也不得进入预设' },
}])));
assert.equal('text' in (sanitized['3x4'].coverPrimary as unknown as Record<string, unknown>), false);
assert.equal('title' in (sanitized['3x4'].coverSecondary as unknown as Record<string, unknown>), false);

console.log('final-edit domain tests passed');
