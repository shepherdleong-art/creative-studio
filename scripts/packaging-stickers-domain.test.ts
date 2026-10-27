// 运行：node scripts/packaging-stickers-domain.test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  STICKER_COMMON_IDS,
  sanitizePackagingStickers,
  sanitizePackagingStickerDefaults,
  validatePackagingStickerDefaults,
  validatePackagingStickers,
  resolveStickerStyle,
  resolveStickerAssetFile,
  resolveStickerAnimation,
  planStickerFramesAtPlayhead,
  createManualPackagingSticker,
  applyPackagingStickerEdit,
  type PackagingStickerInstance,
} from '../lib/media-core/packaging-stickers.ts';
import { parsePackagingConfig } from '../lib/media-core/packaging-vars.ts';
import { buildTimelineVars } from '../lib/media-core/packaging-runtime.ts';
import { resolvePackagingStickerAssets } from '../lib/media-core/packaging-sticker-assets.ts';

function sticker(overrides: Partial<PackagingStickerInstance> = {}): PackagingStickerInstance {
  return {
    id: 'sticker_1',
    assetId: 'highlight',
    styleMode: 'follow-template',
    fixedStyle: null,
    startFrame: 20,
    endFrame: 68,
    centerXPct: 50,
    centerYPct: 40,
    visualWidthPct: 30,
    rotationDeg: 0,
    trackIndex: 0,
    animation: 'follow-template',
    origin: { kind: 'manual' },
    ...overrides,
  };
}

assert.equal(STICKER_COMMON_IDS.length, 28);
const base = sticker();
assert.deepEqual(sanitizePackagingStickers([base]), [base]);
assert.deepEqual(sanitizePackagingStickers([base, base]), [base], '重复实例 ID 只保留第一项');
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', assetId: 'unknown' })]), []);
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', startFrame: 19 })]), []);
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', endFrame: 38 })]), []);
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', styleMode: 'fixed', fixedStyle: null })]), []);
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', fixedStyle: 'show' })]), []);
assert.deepEqual(sanitizePackagingStickers([sticker({ id: 'bad', assetId: 'special' })]), []);
assert.deepEqual(validatePackagingStickers([base], 360), [base]);
assert.throws(() => validatePackagingStickers([sticker({ endFrame: 400 })], 360), /超出正文时间范围/);
assert.throws(() => validatePackagingStickers([sticker({ id: 'bad', centerXPct: 101 })], 360), /非法项/);
assert.throws(() => validatePackagingStickers('bad', 360), /必须是数组/);

assert.deepEqual(planStickerFramesAtPlayhead(0, 240), { startFrame: 20, endFrame: 68 });
assert.deepEqual(planStickerFramesAtPlayhead(1, 240), { startFrame: 24, endFrame: 72 });
assert.deepEqual(planStickerFramesAtPlayhead(220 / 24, 240), { startFrame: 220, endFrame: 260 });
assert.equal(planStickerFramesAtPlayhead(250 / 24, 240), null);
assert.equal(planStickerFramesAtPlayhead(0, 18), null);
assert.equal(planStickerFramesAtPlayhead(999, 240), null);
const manual = createManualPackagingSticker({
  id: 'manual_1', assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
  startFrame: 20, endFrame: 68, centerXPct: 50, centerYPct: 50, animation: 'soft',
});
assert.equal(manual.visualWidthPct, 30);
assert.equal(manual.trackIndex, 0);
assert.deepEqual(manual.origin, { kind: 'manual' });
assert.deepEqual(validatePackagingStickers([manual], 240), [manual]);
const autoEdited = applyPackagingStickerEdit({ ...manual, origin: { kind: 'auto', autoGroupId: 'auto_1', autoEdited: false } }, { centerXPct: 42 });
assert.equal(autoEdited.centerXPct, 42);
assert.deepEqual(autoEdited.origin, { kind: 'auto', autoGroupId: 'auto_1', autoEdited: true });
const forcedSpecial = applyPackagingStickerEdit({ ...manual, assetId: 'special', styleMode: 'fixed', fixedStyle: 'show' }, { styleMode: 'follow-template', fixedStyle: null });
assert.equal(forcedSpecial.styleMode, 'fixed');
assert.equal(forcedSpecial.fixedStyle, 'show');

const special = sticker({ id: 'special_1', assetId: 'special', styleMode: 'fixed', fixedStyle: 'show' });
assert.deepEqual(sanitizePackagingStickers([special]), [special]);
assert.equal(resolveStickerStyle(base, 'overlay-poster'), 'comic');
assert.equal(resolveStickerStyle(base, 'overlay-journal'), 'journal');
assert.equal(resolveStickerStyle(base, 'overlay-minimal'), 'editorial');
assert.equal(resolveStickerStyle(base, 'overlay-variety'), 'show');
assert.equal(resolveStickerStyle(special, 'overlay-poster'), 'show');
assert.equal(resolveStickerAssetFile(base, 'overlay-variety'), 'show/highlight.png');
assert.equal(resolveStickerAnimation('follow-template', 'overlay-poster'), 'bounce');
assert.equal(resolveStickerAnimation('follow-template', 'overlay-journal'), 'soft');
assert.equal(resolveStickerAnimation('zoom', 'overlay-variety'), 'zoom');

assert.deepEqual(sanitizePackagingStickerDefaults({ animation: 'rise' }), { animation: 'rise' });
assert.deepEqual(sanitizePackagingStickerDefaults({ animation: 'invalid' }), { animation: 'follow-template' });
assert.equal(sanitizePackagingStickerDefaults(null), undefined);
assert.deepEqual(validatePackagingStickerDefaults({ animation: 'none' }), { animation: 'none' });
assert.throws(() => validatePackagingStickerDefaults({ animation: 'invalid' }), /默认动效无效/);

const oldConfig = parsePackagingConfig({ enabled: true, template: 'overlay-poster' });
assert.equal(oldConfig.stickers, undefined);
assert.equal(oldConfig.stickerDefaults, undefined);
const config = parsePackagingConfig({ enabled: true, template: 'overlay-variety', stickers: [base], stickerDefaults: { animation: 'soft' } });
assert.deepEqual(config.stickers, [base]);
assert.deepEqual(config.stickerDefaults, { animation: 'soft' });

const stickerAssets = resolvePackagingStickerAssets({ packagingDir: path.resolve('packaging'), template: 'overlay-variety', stickers: [base] });
assert.equal(stickerAssets[base.id].file, 'show/highlight.png');
assert.equal(stickerAssets[base.id].alpha_gt8_bbox.length, 4);
assert.match(stickerAssets[base.id].sha256, /^[a-f0-9]{64}$/);
assert.throws(() => resolvePackagingStickerAssets({ packagingDir: path.resolve('packaging'), template: 'overlay-basic', stickers: [base] }), /不支持贴纸/);
assert.throws(() => resolvePackagingStickerAssets({ packagingDir: path.resolve('packaging'), template: 'overlay-variety', stickers: [sticker({ assetId: 'missing' })] }), /缺少 show\/missing.png/);

const timelineVars = buildTimelineVars({
  vars: { title: '', subtitle: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' },
  totalSec: 15,
  coverSec: 20 / 24,
  pointCues: [],
  pointCuesMode: 'none',
  stickers: [base],
  stickerDefaults: { animation: 'soft' },
  stickerAssets,
});
assert.deepEqual(timelineVars.stickers, [base]);
assert.deepEqual(timelineVars.stickerDefaults, { animation: 'soft' });
assert.deepEqual(timelineVars.stickerAssets, stickerAssets);
console.log('贴纸领域测试通过：清洗、模板映射、资产解析、19/48 帧、旧配置和快照透传。');
