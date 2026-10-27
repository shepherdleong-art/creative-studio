// 运行：node scripts/packaging-sticker-planner.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGING_STICKER_AUTO_SLOTS,
  planPackagingStickerAutoLayout,
  replaceAutomaticPackagingStickers,
  type PackagingStickerPlanningAsset,
} from '../lib/media-core/packaging-sticker-planner.ts';
import { PACKAGING_TEMPLATE_IDS } from '../lib/media-core/packaging-vars.ts';
import { validatePackagingStickers, type PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';

const catalog = JSON.parse(fs.readFileSync(path.resolve('packaging/stickers/catalog.json'), 'utf-8')) as { assets: PackagingStickerPlanningAsset[] };
const assets = catalog.assets;
const categoryByAsset = new Map(assets.map((asset) => [`${asset.style}/${asset.id}`, asset.category]));
const planned = planPackagingStickerAutoLayout({
  bodyFrames: 240,
  template: 'overlay-poster',
  assets,
  animation: 'rise',
  autoGroupId: 'auto_test',
  random: () => 0,
  createId: (index) => `s_auto_${index}`,
});
assert.ok(planned);
assert.equal(planned.length, 6);
assert.deepEqual(validatePackagingStickers(planned, 240), planned);
assert.deepEqual(planned.map((sticker) => categoryByAsset.get(`comic/${sticker.assetId}`)), ['opening', 'opening', 'explain', 'gesture', 'ending', 'ending']);
assert.equal(new Set(planned.slice(0, 2).map((sticker) => sticker.assetId)).size, 2, '开头两张不得重复');
assert.equal(new Set(planned.slice(4).map((sticker) => sticker.assetId)).size, 2, '结尾两张不得重复');
assert.ok(planned.every((sticker) => !['arrow_left', 'arrow_right', 'oval', 'round'].includes(sticker.assetId)), '箭头圈注不得进入自动池');
assert.ok(planned.every((sticker) => sticker.animation === 'rise' && sticker.styleMode === 'follow-template' && sticker.fixedStyle === null));
assert.ok(planned.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'auto_test' && !sticker.origin.autoEdited));
for (let index = 0; index < planned.length; index += 1) {
  const sticker = planned[index];
  const stageIndex = Math.floor(index / 2);
  const stageStart = 20 + Math.round(stageIndex * 240 / 3);
  const stageEnd = 20 + Math.round((stageIndex + 1) * 240 / 3);
  const stageFrames = stageEnd - stageStart;
  const centerFrame = stageStart + Math.round(stageFrames * (index % 2 === 0 ? 0.25 : 0.75));
  assert.equal(sticker.endFrame - sticker.startFrame, 32);
  assert.equal(sticker.startFrame + 16, centerFrame);
  assert.ok(sticker.startFrame >= stageStart && sticker.endFrame <= stageEnd, `第 ${index + 1} 张不得越过本阶段`);
  if (index > 0) assert.ok(sticker.startFrame >= planned[index - 1].endFrame, '六张默认不得时间重叠');
}
const tailRandom = planPackagingStickerAutoLayout({ bodyFrames: 144, template: 'overlay-variety', assets, animation: 'soft', autoGroupId: 'auto_tail', random: () => 0.999, createId: (index) => `tail_${index}` });
assert.ok(tailRandom);
assert.equal(new Set(tailRandom.slice(0, 2).map((sticker) => sticker.assetId)).size, 2);
assert.equal(new Set(tailRandom.slice(4).map((sticker) => sticker.assetId)).size, 2);
assert.ok(tailRandom.every((sticker) => sticker.endFrame - sticker.startFrame === 19), '最短合法阶段使用 19 帧下限');
let randomCalls = 0;
assert.equal(planPackagingStickerAutoLayout({ bodyFrames: 143, template: 'overlay-poster', assets, animation: 'soft', autoGroupId: 'auto_short', random: () => { randomCalls += 1; return 0; }, createId: String }), null);
assert.equal(randomCalls, 0, '短视频门禁前不得消耗随机结果');

for (const template of PACKAGING_TEMPLATE_IDS) {
  const templatePlan = planPackagingStickerAutoLayout({ bodyFrames: 240, template, assets, animation: 'follow-template', autoGroupId: `auto_${template}`, random: () => 0, createId: (index) => `${template}_${index}` });
  assert.ok(templatePlan);
  const slots = PACKAGING_STICKER_AUTO_SLOTS[template];
  assert.equal(slots.length, 6);
  templatePlan.forEach((sticker, index) => {
    assert.equal(sticker.centerXPct, slots[index].centerXPct);
    assert.equal(sticker.centerYPct, slots[index].centerYPct);
    assert.equal(sticker.visualWidthPct, slots[index].visualWidthPct);
    assert.equal(sticker.rotationDeg, slots[index].rotationDeg);
    assert.ok(sticker.centerXPct > 0 && sticker.centerXPct < 100 && sticker.centerYPct > 0 && sticker.centerYPct < 100);
  });
}

const manual: PackagingStickerInstance = { ...planned[0], id: 'manual_keep', origin: { kind: 'manual' } };
const copiedAsManual: PackagingStickerInstance = { ...planned[1], id: 'copy_keep', origin: { kind: 'manual' } };
const replacement = planned.map((sticker, index) => ({ ...sticker, id: `new_${index}`, origin: { kind: 'auto' as const, autoGroupId: 'auto_new', autoEdited: false } }));
const replaced = replaceAutomaticPackagingStickers([manual, ...planned, copiedAsManual], replacement);
assert.equal(replaced.length, 8, '换一组必须保持 6 张自动贴纸而不是叠加');
assert.deepEqual(replaced[0], manual, '手动贴纸必须原样保留');
assert.deepEqual(replaced[1], copiedAsManual, '复制后转为手动的贴纸必须保留');
assert.equal(replaced.slice(2).every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'auto_new'), true);
assert.equal(replaced.some((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'auto_test'), false);
console.log('贴纸自动布置测试通过：固定随机、分类无重复、144 帧门禁、三阶段、四模板六槽位与手动保留。');
