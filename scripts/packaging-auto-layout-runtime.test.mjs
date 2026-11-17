// 运行：node scripts/packaging-auto-layout-runtime.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { solveAutoLayout, expanded, translateBox, intersects, scaleFor } = require('../packaging/auto-layout/runtime.js');

function element(id, options = {}) {
  const width = options.outputWidth ?? 1080;
  const height = options.outputHeight ?? 1440;
  const centerXPct = options.centerXPct ?? 25;
  const centerYPct = options.centerYPct ?? 25;
  const boxWidth = options.boxWidth ?? 120;
  const boxHeight = options.boxHeight ?? 80;
  const cx = centerXPct / 100 * width;
  const cy = centerYPct / 100 * height;
  const frames = (options.frames ?? [30]).map(frame => ({
    frame,
    opacity: 1,
    box: { left: cx - boxWidth / 2, top: cy - boxHeight / 2, right: cx + boxWidth / 2, bottom: cy + boxHeight / 2 },
  }));
  return {
    id, kind: options.kind ?? 'sticker', stage: options.stage ?? 'opening',
    layoutVersion: options.layoutVersion ?? 2,
    positionPinned: options.positionPinned,
    manualLayout: options.manualLayout,
    centerXPct, centerYPct, frames,
  };
}

for (const [outputWidth, outputHeight] of [[1080, 1440], [1080, 1920], [1920, 1080]]) {
  const source = element(`safe_${outputWidth}_${outputHeight}`, { outputWidth, outputHeight, centerYPct: 60, boxWidth: 200, boxHeight: 200 });
  const result = solveAutoLayout({ outputWidth, outputHeight, elements: [source] });
  assert.equal(result.status, 'resolved');
  const resolved = result.elements[source.id];
  const dx = resolved.centerXPct / 100 * outputWidth - source.centerXPct / 100 * outputWidth;
  const dy = resolved.centerYPct / 100 * outputHeight - source.centerYPct / 100 * outputHeight;
  for (const frame of source.frames) {
    const box = translateBox(frame.box, dx, dy);
    assert.ok(box.left >= -0.01 && box.right <= outputWidth + 0.01);
    assert.ok(box.top >= -0.01 && box.bottom <= outputHeight * 0.4 + 0.01, `${outputWidth}x${outputHeight} 完整外框必须在上40%`);
  }
}

const cueOutside = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('cue_outside', { kind: 'pointCue', centerYPct: 54 })],
});
assert.equal(cueOutside.status, 'resolved', '没有贴纸时，越界卖点也必须进入求解');
const cueOutsideSource = cueOutside && cueOutside.elements ? cueOutside.elements.cue_outside : null;
assert.ok(cueOutsideSource && cueOutsideSource.centerYPct < 54, '卖点不得因第一阶段提前返回而停留在 54%');
const cueOutsideDy = (cueOutsideSource.centerYPct - 54) / 100 * 1440;
assert.ok(translateBox({ left: 480, top: 737.6, right: 600, bottom: 817.6 }, 0, cueOutsideDy).bottom <= 1440 * 0.4 + 0.01,
  '卖点完整外框必须被移回上 40%，不能只检查重叠');

const offsetCue = element('offset_cue', { kind: 'pointCue', centerXPct: 70, centerYPct: 40 });
offsetCue.frames = [{ frame: 30, opacity: 1, box: { left: 680, top: 639, right: 900, bottom: 706 } }];
const offsetResult = solveAutoLayout({ outputWidth: 1080, outputHeight: 1440, elements: [offsetCue] });
assert.equal(offsetResult.status, 'resolved');
const offsetCenter = offsetResult.elements.offset_cue;
assert.ok(offsetCenter.centerXPct >= 0 && offsetCenter.centerXPct <= 100
  && offsetCenter.centerYPct >= 0 && offsetCenter.centerYPct <= 100,
'偏移可见外框不得把持久化锚点推出 0–100% 画布范围');
const offsetDy = (offsetCenter.centerYPct - 40) / 100 * 1440;
const offsetBox = translateBox(offsetCue.frames[0].box, 0, offsetDy);
assert.ok(offsetBox.top >= 0 && offsetBox.bottom <= 1440 * 0.4 + 0.01, '锚点受限后完整外框仍须位于上 40%');

const fixedOnly = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('manual', { centerYPct: 80, positionPinned: true }), element('ending', { centerYPct: 56, stage: 'ending' })],
});
assert.equal(fixedOnly.status, 'resolved');
assert.equal(fixedOnly.elements.manual.centerYPct, 80);
assert.equal(fixedOnly.elements.ending.centerYPct, 56);

const separate = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('a', { centerXPct: 20 }), element('b', { centerXPct: 80 })],
});
assert.equal(separate.elements.a.centerXPct, 20);
assert.equal(separate.elements.b.centerXPct, 80);
const timeSeparate = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('a', { frames: [20] }), element('b', { frames: [60] })],
});
assert.equal(timeSeparate.elements.a.centerXPct, 25);
assert.equal(timeSeparate.elements.b.centerXPct, 25);

const collisionInput = {
  outputWidth: 1080, outputHeight: 1440,
  elements: [
    element('sticker', { centerXPct: 25, centerYPct: 25, frames: [30], boxHeight: 20 }),
    element('cue', { kind: 'pointCue', centerXPct: 25, centerYPct: 25, frames: [30], boxHeight: 20 }),
  ],
};
const collision = solveAutoLayout(collisionInput);
assert.equal(collision.status, 'resolved');
assert.equal(collision.elements.cue.centerXPct, 25);
assert.equal(collision.elements.cue.centerYPct, 25, '小幅贴纸解存在时卖点不应移动');
assert.notDeepEqual(collision.elements.sticker, { centerXPct: 25, centerYPct: 25 });
const s = collisionInput.elements[0];
const c = collisionInput.elements[1];
const sr = collision.elements.sticker;
const cr = collision.elements.cue;
const sBox = expanded(translateBox(s.frames[0].box,
  (sr.centerXPct - s.centerXPct) / 100 * 1080, (sr.centerYPct - s.centerYPct) / 100 * 1440), 4);
const cBox = expanded(translateBox(c.frames[0].box,
  (cr.centerXPct - c.centerXPct) / 100 * 1080, (cr.centerYPct - c.centerYPct) / 100 * 1440), 4);
assert.equal(intersects(sBox, cBox, 0.01), false, '同时可见元素避让后必须无碰撞');
assert.deepEqual(solveAutoLayout(collisionInput), collision, '相同输入必须得到完全相同结果');

const fixedOverlap = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [
    element('fixed_a', { positionPinned: true }),
    element('fixed_b', { positionPinned: true }),
    element('auto', { centerXPct: 80 }),
  ],
});
assert.equal(fixedOverlap.status, 'resolved', '固定—固定重叠不得制造伪无解');
assert.equal(fixedOverlap.elements.fixed_a.centerXPct, 25);
assert.equal(fixedOverlap.elements.fixed_b.centerXPct, 25);

const infeasible = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('too_tall', { boxHeight: 600 })],
});
assert.equal(infeasible.status, 'infeasible');
assert.equal(infeasible.conflicts[0].elementId, 'too_tall');
const budget = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440, maxNodes: 1,
  elements: [element('budget_a', { boxHeight: 20 }), element('budget_b', { boxHeight: 20 })],
});
assert.equal(budget.status, 'budget_exceeded');

const manualCue = solveAutoLayout({
  outputWidth: 1080, outputHeight: 1440,
  elements: [element('manual_cue', { kind: 'pointCue', centerYPct: 70, manualLayout: true })],
});
assert.equal(manualCue.elements.manual_cue.centerYPct, 70);
assert.equal(scaleFor(1920, 1080), 0.75);

console.log('自动布局运行时测试通过：三画幅、完整外框、固定集合、时空碰撞、联合求解、失败分类与确定性。');
