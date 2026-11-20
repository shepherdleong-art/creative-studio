// 运行：node scripts/packaging-auto-layout.test.ts
import assert from 'node:assert/strict';
import {
  isPotentiallyMovableV2Sticker,
  resolveLayoutRuntimeBundleVersion,
  resolvePointCuesLayoutVersion,
  sanitizePackagingLayoutResolution,
} from '../lib/media-core/packaging-auto-layout.ts';
import type { PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';
import { assertSupportedPackagingConfigLayoutVersions, parsePackagingConfig } from '../lib/media-core/packaging-vars.ts';

assert.equal(resolvePointCuesLayoutVersion(undefined, 'initial'), 2);
assert.equal(resolvePointCuesLayoutVersion(1, 'explicit-reextract'), 2);
assert.equal(resolvePointCuesLayoutVersion(undefined, 'explicit-reextract'), 2);
assert.equal(resolvePointCuesLayoutVersion(undefined, 'automatic-rebuild'), undefined);
assert.equal(resolvePointCuesLayoutVersion(2, 'automatic-rebuild'), 2);
assert.equal(resolvePointCuesLayoutVersion(undefined, 'derived-version'), undefined);
assert.equal(resolvePointCuesLayoutVersion(1, 'derived-version'), 1);
assert.throws(() => resolvePointCuesLayoutVersion(3, 'automatic-rebuild'), /不支持的布局版本/);

const automaticV2: PackagingStickerInstance = {
  id: 's_v2', assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
  startFrame: 20, endFrame: 68, centerXPct: 22, centerYPct: 24,
  visualWidthPct: 25, rotationDeg: 0, trackIndex: 0, animation: 'soft',
  origin: { kind: 'auto', autoGroupId: 'auto_v2', autoEdited: false, layoutVersion: 2 },
};
assert.equal(resolveLayoutRuntimeBundleVersion({ stickers: [automaticV2] }), 2);
assert.equal(resolveLayoutRuntimeBundleVersion({ pointCuesLayoutVersion: 2 }), 2);
assert.equal(resolveLayoutRuntimeBundleVersion({ previous: 2 }), 2, '删除 v2 元素不得静默降级 bundle');
assert.equal(resolveLayoutRuntimeBundleVersion({}), undefined);
assert.equal(isPotentiallyMovableV2Sticker(automaticV2, 'opening'), true);
assert.equal(isPotentiallyMovableV2Sticker(automaticV2, 'middle'), true);
assert.equal(isPotentiallyMovableV2Sticker(automaticV2, 'ending'), false);
assert.equal(isPotentiallyMovableV2Sticker({
  ...automaticV2,
  origin: { kind: 'auto', autoGroupId: 'auto_v2', autoEdited: false, layoutVersion: 2, positionPinned: true },
}, 'opening'), false);

const mixed = parsePackagingConfig({
  enabled: true,
  template: 'overlay-poster',
  pointCuesLayoutVersion: 2,
  layoutRuntimeBundleVersion: 2,
  stickers: [automaticV2],
});
assert.equal(mixed.pointCuesLayoutVersion, 2);
assert.equal(mixed.layoutRuntimeBundleVersion, 2);
assertSupportedPackagingConfigLayoutVersions(mixed);
assert.equal(parsePackagingConfig({ enabled: true }).pointCuesLayoutVersion, undefined);
assert.throws(
  () => assertSupportedPackagingConfigLayoutVersions(parsePackagingConfig({ enabled: true, pointCuesLayoutVersion: 3 })),
  /不支持的自动布局版本/,
);

const resolution = sanitizePackagingLayoutResolution({
  schemaVersion: 1,
  status: 'resolved',
  inputHash: 'a'.repeat(64),
  runtimeBundleVersion: 2,
  geometryManifestHash: 'b'.repeat(64),
  outputWidth: 1080,
  outputHeight: 1920,
  elements: {
    s_v2: { id: 's_v2', kind: 'sticker', centerXPct: 24, centerYPct: 25, positionPinned: false, fit: { zoom: 1 } },
  },
  validation: { frameCount: 48, digest: 'frames' },
});
assert.ok(resolution);
assert.equal(resolution.outputHeight, 1920);
assert.equal(resolution.elements.s_v2.centerYPct, 25);
assert.equal(sanitizePackagingLayoutResolution({ ...resolution, elements: { bad: { id: 'wrong' } } }), undefined);
assert.equal(parsePackagingConfig({ enabled: true, layoutResolution: resolution }).layoutResolution?.inputHash, 'a'.repeat(64));

console.log('自动布局领域测试通过：版本升级、混合 bundle、可移动集合、未知版本与旧配置兼容。');
