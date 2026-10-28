// 运行：node scripts/packaging-sticker-variants.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGING_STICKER_AUTO_SLOTS,
  planPackagingStickerAutoLayout,
  type PackagingStickerPlanningAsset,
} from '../lib/media-core/packaging-sticker-planner.ts';
import {
  STICKER_INTRO_FRAMES,
  PackagingStickerError,
  validatePackagingStickers,
  type PackagingStickerInstance,
} from '../lib/media-core/packaging-stickers.ts';
import {
  PACKAGING_STICKER_VARIANT_ANIMATIONS,
  assertPackagingStickerVariantTarget,
  planPackagingStickerVariants,
  type PackagingStickerVariantIdRequest,
} from '../lib/media-core/packaging-sticker-variants.ts';

const catalog = JSON.parse(fs.readFileSync(path.resolve('packaging/stickers/catalog.json'), 'utf-8')) as { assets: PackagingStickerPlanningAsset[] };
const assets = catalog.assets;
const categoryByStyleAsset = new Map(assets.map((asset) => [`${asset.style}/${asset.id}`, asset.category]));

function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    assert.ok(index < values.length, '随机源调用次数超出固定序列');
    return values[index++];
  };
}

function createId(request: PackagingStickerVariantIdRequest): string {
  return request.kind === 'autoGroup'
    ? `group_${request.targetIndex}_${request.sourceAutoGroupId}`
    : `sticker_${request.targetIndex}_${request.sourceStickerId}`;
}

const initial = planPackagingStickerAutoLayout({
  bodyFrames: 240,
  template: 'overlay-poster',
  assets,
  animation: 'follow-template',
  autoGroupId: 'source_group',
  random: () => 0,
  createId: (index) => `source_${index}`,
});
assert.ok(initial);
const fullSource = initial.map((sticker, index) => ({
  ...sticker,
  visualWidthPct: 20 + index,
  rotationDeg: index - 2,
  trackIndex: index,
}));
const fullSourceSnapshot = structuredClone(fullSource);

// 完整六张：三阶段、同阶段素材与槽位去重、保留尺寸/旋转/轨道，每张独立抽取可见动效。
const animationValues = [0, 0.2, 0.4, 0.6, 0.8, 0.99];
const fullRandomValues = Array.from({ length: 18 }, (_, index) => index % 3 === 2 ? animationValues[Math.floor(index / 3)] : 0);
const fullInput = {
  sourceBodyFrames: 240,
  sourceStickers: fullSource,
  targets: [{ targetId: 'full', bodyFrames: 360, template: 'overlay-journal' as const }],
  assets,
  createId,
};
const fullPlan = planPackagingStickerVariants({ ...fullInput, random: sequenceRandom(fullRandomValues) });
assert.deepEqual(fullPlan, planPackagingStickerVariants({ ...fullInput, random: sequenceRandom(fullRandomValues) }), '固定随机源与 ID 生成器必须完整复现');
assert.deepEqual(fullSource, fullSourceSnapshot, '规划不得修改来源实例');
const full = fullPlan[0].stickers;
assert.equal(full.length, 6);
assert.deepEqual(full.map((sticker) => categoryByStyleAsset.get(`journal/${sticker.assetId}`)), ['opening', 'opening', 'explain', 'gesture', 'ending', 'ending']);
assert.deepEqual(full.map((sticker) => sticker.animation), ['soft', 'bounce', 'rise', 'slide', 'zoom', 'zoom']);
assert.ok(full.every((sticker) => PACKAGING_STICKER_VARIANT_ANIMATIONS.includes(sticker.animation as typeof PACKAGING_STICKER_VARIANT_ANIMATIONS[number])));
assert.ok(full.every((sticker) => sticker.styleMode === 'follow-template' && sticker.fixedStyle === null));
assert.ok(full.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'group_0_source_group' && !sticker.origin.autoEdited));
assert.equal(validatePackagingStickers(full, 360).length, 6);
for (let index = 0; index < full.length; index += 1) {
  const sticker = full[index];
  const stageIndex = Math.floor(index / 2);
  const stageStart = STICKER_INTRO_FRAMES + Math.round(stageIndex * 360 / 3);
  const stageFrames = 120;
  const duration = 48;
  const center = stageStart + Math.round(stageFrames * (index % 2 === 0 ? 0.25 : 0.75));
  assert.equal(sticker.endFrame - sticker.startFrame, duration);
  assert.equal(sticker.startFrame, center - Math.floor(duration / 2));
  assert.equal(sticker.visualWidthPct, fullSource[index].visualWidthPct);
  assert.equal(sticker.rotationDeg, fullSource[index].rotationDeg);
  assert.equal(sticker.trackIndex, fullSource[index].trackIndex);
  const stageSlots = PACKAGING_STICKER_AUTO_SLOTS['overlay-journal'].slice(stageIndex * 2, stageIndex * 2 + 2);
  assert.ok(stageSlots.some((slot) => slot.centerXPct === sticker.centerXPct && slot.centerYPct === sticker.centerYPct));
}
for (const [start, end] of [[0, 2], [2, 4], [4, 6]]) {
  const stage = full.slice(start, end);
  assert.equal(new Set(stage.map((sticker) => sticker.assetId)).size, 2, '同目标同阶段素材不得重复');
  assert.equal(new Set(stage.map((sticker) => `${sticker.centerXPct}/${sticker.centerYPct}`)).size, 2, '同阶段两张优先使用不同槽位');
}

// 不同目标时长沿用默认时长算法；所有实例 ID 与自动组 ID 跨目标更新。
const durationsInput = {
  sourceBodyFrames: 240,
  sourceStickers: fullSource,
  targets: [
    { targetId: 'shortest', bodyFrames: 144, template: 'overlay-poster' as const },
    { targetId: 'longer', bodyFrames: 300, template: 'overlay-poster' as const },
  ],
  assets,
  random: () => 0.999,
  createId,
};
const durationPlans = planPackagingStickerVariants(durationsInput);
assert.ok(durationPlans[0].stickers.every((sticker) => sticker.endFrame - sticker.startFrame === 19));
assert.ok(durationPlans[1].stickers.every((sticker) => sticker.endFrame - sticker.startFrame === 40));
assert.deepEqual(durationPlans, planPackagingStickerVariants(durationsInput));
const allTargetIds = durationPlans.flatMap((plan) => plan.stickers.map((sticker) => sticker.id));
assert.equal(new Set(allTargetIds).size, 12);
assert.ok(allTargetIds.every((id) => !fullSource.some((sticker) => sticker.id === id)));
assert.ok(durationPlans[0].stickers.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'group_0_source_group'));
assert.ok(durationPlans[1].stickers.every((sticker) => sticker.origin.kind === 'auto' && sticker.origin.autoGroupId === 'group_1_source_group'));

// 部分自动组合只复制来源仍存在的实例；单张阶段使用 25% 时间点与任一安全槽位。
const partialSource = fullSource.filter((_, index) => [1, 2, 5].includes(index));
const partial = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: partialSource,
  targets: [{ targetId: 'partial', bodyFrames: 240, template: 'overlay-minimal' }],
  assets,
  random: () => 0,
  createId,
})[0].stickers;
assert.equal(partial.length, 3, '不得补回来源已删除的自动贴纸');
assert.deepEqual(partial.map((sticker) => sticker.id), ['sticker_0_source_1', 'sticker_0_source_2', 'sticker_0_source_5']);
partial.forEach((sticker, index) => {
  const stageStart = STICKER_INTRO_FRAMES + Math.round(index * 240 / 3);
  assert.equal(sticker.startFrame, stageStart + 4);
  assert.equal(sticker.endFrame - sticker.startFrame, 32);
  const slots = PACKAGING_STICKER_AUTO_SLOTS['overlay-minimal'].slice(index * 2, index * 2 + 2);
  assert.ok(slots.some((slot) => slot.centerXPct === sticker.centerXPct && slot.centerYPct === sticker.centerYPct));
});

function manualSticker(overrides: Partial<PackagingStickerInstance> = {}): PackagingStickerInstance {
  return {
    id: 'manual',
    assetId: 'highlight',
    styleMode: 'fixed',
    fixedStyle: 'show',
    startFrame: 20,
    endFrame: 140,
    centerXPct: 47,
    centerYPct: 53,
    visualWidthPct: 37,
    rotationDeg: 12,
    trackIndex: 7,
    animation: 'slide',
    origin: { kind: 'manual' },
    ...overrides,
  };
}

// 纯手动不套用 144 帧门禁，正文相对帧等比映射且其余字段原样保留。
const manual = manualSticker();
let manualRandomCalls = 0;
const manualPlan = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: [manual],
  targets: [{ targetId: 'manual', bodyFrames: 40, template: 'overlay-variety' }],
  assets,
  random: () => { manualRandomCalls += 1; return 0; },
  createId,
})[0].stickers[0];
assert.equal(manualRandomCalls, 0);
assert.deepEqual(manualPlan, { ...manual, id: 'sticker_0_manual', startFrame: 20, endFrame: 40 });
assertPackagingStickerVariantTarget({ sourceBodyFrames: 240, targetBodyFrames: 40, sourceStickers: [manual] });

// 已编辑自动贴纸同样按比例映射，保留素材、固定风格、位置、动效和 autoEdited 身份。
const edited = manualSticker({
  id: 'edited',
  animation: 'none',
  origin: { kind: 'auto', autoGroupId: 'edited_group', autoEdited: true },
});
const editedPlan = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: [edited],
  targets: [{ targetId: 'edited', bodyFrames: 40, template: 'overlay-journal' }],
  assets,
  random: () => { throw new Error('已编辑自动贴纸不得消耗随机源'); },
  createId,
})[0].stickers[0];
assert.deepEqual(editedPlan, {
  ...edited,
  id: 'sticker_0_edited',
  startFrame: 20,
  endFrame: 40,
  origin: { kind: 'auto', autoGroupId: 'group_0_edited_group', autoEdited: true },
});

// 映射后的 19 帧下限与正文边界明确报错，不能用 clamp 静默修复。
assert.throws(
  () => assertPackagingStickerVariantTarget({
    sourceBodyFrames: 240,
    targetBodyFrames: 60,
    sourceStickers: [manualSticker({ startFrame: 20, endFrame: 68 })],
  }),
  (error: unknown) => error instanceof PackagingStickerError && error.code === 'sticker_out_of_range',
);
assert.throws(
  () => assertPackagingStickerVariantTarget({
    sourceBodyFrames: 240,
    targetBodyFrames: 240,
    sourceStickers: [manualSticker({ startFrame: 19, endFrame: 139 })],
  }),
  (error: unknown) => error instanceof PackagingStickerError && error.code === 'sticker_out_of_range',
);

// 未编辑自动实例触发 144 帧门禁；多目标先整体预检，失败前不消耗随机或 ID。
let shortRandomCalls = 0;
let shortIdCalls = 0;
assert.throws(
  () => planPackagingStickerVariants({
    sourceBodyFrames: 240,
    sourceStickers: fullSource,
    targets: [
      { targetId: 'valid', bodyFrames: 144, template: 'overlay-poster' },
      { targetId: 'short', bodyFrames: 143, template: 'overlay-poster' },
    ],
    assets,
    random: () => { shortRandomCalls += 1; return 0; },
    createId: (request) => { shortIdCalls += 1; return createId(request); },
  }),
  (error: unknown) => error instanceof PackagingStickerError && error.code === 'sticker_auto_body_too_short',
);
assert.equal(shortRandomCalls, 0);
assert.equal(shortIdCalls, 0);

// 来源及先前目标使用计数优先避开高使用素材，同阶段仍不重复。
const openingAssets = [
  { style: 'comic', category: 'opening', id: 'recommend' },
  { style: 'comic', category: 'opening', id: 'good_find' },
  { style: 'comic', category: 'opening', id: 'first_sight' },
] satisfies PackagingStickerPlanningAsset[];
const poolSource = fullSource.slice(0, 2).map((sticker, index) => ({ ...sticker, assetId: index === 0 ? 'recommend' : 'good_find' }));
const poolPlans = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: poolSource,
  targets: [
    { targetId: 'pool_a', bodyFrames: 240, template: 'overlay-poster' },
    { targetId: 'pool_b', bodyFrames: 240, template: 'overlay-poster' },
  ],
  assets: openingAssets,
  random: () => 0,
  createId,
});
assert.deepEqual(poolPlans[0].stickers.map((sticker) => sticker.assetId), ['first_sight', 'recommend']);
assert.deepEqual(poolPlans[1].stickers.map((sticker) => sticker.assetId), ['good_find', 'first_sight']);
for (const plan of poolPlans) assert.equal(new Set(plan.stickers.map((sticker) => sticker.assetId)).size, 2);

// 池耗尽先允许跨片重复；单片唯一素材不足两张时也有限放宽，不死循环、不报池长度错误。
const exhaustedSource = poolSource.map((sticker) => ({ ...sticker, assetId: 'recommend' }));
const exhausted = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: exhaustedSource,
  targets: [
    { targetId: 'exhausted_a', bodyFrames: 240, template: 'overlay-poster' },
    { targetId: 'exhausted_b', bodyFrames: 240, template: 'overlay-poster' },
  ],
  assets: openingAssets.slice(0, 1),
  random: () => 0.999,
  createId,
});
assert.equal(exhausted.flatMap((plan) => plan.stickers).length, 4);
assert.ok(exhausted.every((plan) => plan.stickers.every((sticker) => sticker.assetId === 'recommend')));
assert.ok(exhausted.every((plan) => new Set(plan.stickers.map((sticker) => `${sticker.centerXPct}/${sticker.centerYPct}`)).size === 2));

// 不同来源自动组在每条目标内分别映射，同一来源组保持一致，autoEdited 标记不丢失。
const groupedSource = [
  { ...fullSource[0], origin: { kind: 'auto' as const, autoGroupId: 'group_a', autoEdited: false } },
  { ...fullSource[1], origin: { kind: 'auto' as const, autoGroupId: 'group_a', autoEdited: false } },
  { ...fullSource[2], origin: { kind: 'auto' as const, autoGroupId: 'group_b', autoEdited: true } },
];
const grouped = planPackagingStickerVariants({
  sourceBodyFrames: 240,
  sourceStickers: groupedSource,
  targets: [
    { targetId: 'grouped_a', bodyFrames: 240, template: 'overlay-poster' },
    { targetId: 'grouped_b', bodyFrames: 240, template: 'overlay-poster' },
  ],
  assets,
  random: () => 0,
  createId,
});
grouped.forEach((plan, targetIndex) => {
  const origins = plan.stickers.map((sticker) => sticker.origin);
  assert.deepEqual(origins[0], { kind: 'auto', autoGroupId: `group_${targetIndex}_group_a`, autoEdited: false });
  assert.deepEqual(origins[1], origins[0]);
  assert.deepEqual(origins[2], { kind: 'auto', autoGroupId: `group_${targetIndex}_group_b`, autoEdited: true });
});
assert.notEqual(grouped[0].stickers[0].origin.kind === 'auto' && grouped[0].stickers[0].origin.autoGroupId, grouped[1].stickers[0].origin.kind === 'auto' && grouped[1].stickers[0].origin.autoGroupId);

console.log('贴纸跨片变体测试通过：比例映射、三阶段、完整/部分组合、短时长、跨目标去重与池耗尽、五动效、安全槽位及身份刷新。');
