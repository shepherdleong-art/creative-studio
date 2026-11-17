// 运行：node scripts/packaging-auto-layout-service.test.ts
// 需要 packaging 内置 Chrome、真实模板、字体与贴纸素材。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-service-test-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const { resolvePackagingAutoLayout } = await import('../lib/media-core/packaging-auto-layout-service.ts');
import { planPackagingStickerAutoLayout, type PackagingStickerPlanningAsset } from '../lib/media-core/packaging-sticker-planner.ts';
import { PACKAGING_TEMPLATE_IDS, type PackagingTemplateId, type PackagingVars } from '../lib/media-core/packaging-vars.ts';
const { assertPackagingLayoutExportReady } = await import('../lib/media-core/packaging-layout-manifest.ts');
import { sanitizePackagingLayoutResolution } from '../lib/media-core/packaging-auto-layout.ts';

const { assets } = JSON.parse(fs.readFileSync(path.resolve('packaging/stickers/catalog.json'), 'utf8')) as { assets: PackagingStickerPlanningAsset[] };
const bodyFrames = 240;
const totalSec = (bodyFrames + 20) / 24;
const coverSec = 20 / 24;
function stickersFor(template: PackagingTemplateId, outputWidth: number, outputHeight: number) {
  const stickers = planPackagingStickerAutoLayout({
    bodyFrames,
    template,
    assets,
    animation: 'soft',
    autoGroupId: 'auto_service',
    random: () => 0,
    createId: index => `s_service_${index}`,
    outputWidth,
    outputHeight,
  })!;
  stickers.push({
    id: 's_manual', assetId: 'highlight', styleMode: 'follow-template', fixedStyle: null,
    startFrame: 20, endFrame: 68, centerXPct: 50, centerYPct: 55,
    visualWidthPct: 20, rotationDeg: 0, trackIndex: 0, animation: 'none', origin: { kind: 'manual' },
  });
  return stickers;
}
const vars: PackagingVars = {
  title: '测试产品', subtitle: '真实布局服务', point1: '舒适耐用', point2: '环保材质', point3: '三年质保',
  accent1: '', accent2: '', accent3: '',
};

try {
for (const template of PACKAGING_TEMPLATE_IDS.filter((id) => !process.env.LAYOUT_TEST_TEMPLATE || id === process.env.LAYOUT_TEST_TEMPLATE)) {
  for (const [outputWidth, outputHeight] of [[1080, 1440], [1080, 1920], [1920, 1080]] as const) {
    if (process.env.LAYOUT_TEST_SIZE && `${outputWidth}x${outputHeight}` !== process.env.LAYOUT_TEST_SIZE) continue;
    const stickers = stickersFor(template, outputWidth, outputHeight);
    console.log(`布局验收：${template} ${outputWidth}x${outputHeight}`);
    const config = {
      enabled: true as const,
      template,
      varsOverrides: {},
      pointCues: [
        { id: 'p_service_a', text: '舒适耐用', startSec: coverSec + 0.2, endSec: 3 },
        { id: 'p_service_b', text: '环保材质', startSec: 3.2, endSec: 5.2 },
      ],
      pointCuesMode: 'timed' as const,
      pointCuesLayoutVersion: 2,
      layoutRuntimeBundleVersion: 2,
      stickers,
    };
    const result = await resolvePackagingAutoLayout({
      config,
      vars,
      totalSec,
      coverSec,
      outputWidth,
      outputHeight,
    });
    if (result.status !== 'resolved') console.error(`${template} ${outputWidth}x${outputHeight} 布局失败详情`, JSON.stringify(result));
    assert.equal(result.status, 'resolved', `${template} ${outputWidth}x${outputHeight}: ${result.status}`);
    if (result.status !== 'resolved') throw new Error('布局未解析');
    assert.ok(await assertPackagingLayoutExportReady({ ...config, layoutResolution: result }, outputWidth, outputHeight), '每种画幅都必须通过导出门禁');
    assert.equal(result.outputWidth, outputWidth);
    assert.equal(result.outputHeight, outputHeight);
    assert.match(result.inputHash, /^[a-f0-9]{64}$/);
    assert.match(result.geometryManifestHash, /^[a-f0-9]{64}$/);
    assert.equal(result.elements.s_manual.centerXPct, 50);
    assert.equal(result.elements.s_manual.centerYPct, 55);
    assert.ok(result.validation.frameCount > 0);
    assert.ok(Object.keys(result.elements).length >= 8);
    assert.ok(sanitizePackagingLayoutResolution(result), `${template} ${outputWidth}x${outputHeight} 必须能通过持久化 schema`);
    for (const element of Object.values(result.elements)) {
      if (element.kind === 'pointCue') {
        assert.ok(element.visualBox && element.visualBox.bottom <= outputHeight * 0.4 + 0.05,
          `${template} ${outputWidth}x${outputHeight} 的 ${element.id} 完整外框必须位于上 40%`);
      }
    }
    assert.equal(result.elements.s_service_4.centerYPct, 65, '结尾左贴纸必须保持下半部槽位');
    assert.equal(result.elements.s_service_5.centerYPct, 81, '结尾右贴纸必须保持下半部槽位');
    if (template === 'overlay-poster' && outputWidth === 1080 && outputHeight === 1440) {
      const replayed = await resolvePackagingAutoLayout({
        config: { ...config, layoutResolution: result },
        vars,
        totalSec,
        coverSec,
        outputWidth,
        outputHeight,
      });
      assert.equal(replayed.status, 'resolved');
      if (replayed.status !== 'resolved') throw new Error('布局重放失败');
      const verified = await assertPackagingLayoutExportReady({ ...config, layoutResolution: result }, outputWidth, outputHeight);
      assert.ok(verified && fs.existsSync(path.join(verified.bundleDir, 'manifest.json')), 'v2 必须物化冻结布局资源');
      const frozenReplay = path.join(verified!.bundleDir, 'auto-layout', 'replay.js');
      const frozenBytes = fs.readFileSync(frozenReplay);
      try {
        fs.writeFileSync(frozenReplay, '// tampered\n');
        await assert.rejects(() => assertPackagingLayoutExportReady({ ...config, layoutResolution: result }, outputWidth, outputHeight), /已变化|缺失|不一致/);
      } finally {
        fs.writeFileSync(frozenReplay, frozenBytes);
      }
      await assert.doesNotReject(() => assertPackagingLayoutExportReady({ ...config, layoutResolution: result }, outputWidth, outputHeight));
      await assert.rejects(() => assertPackagingLayoutExportReady({ ...config, layoutResolution: { ...result, status: 'stale' as const } }, outputWidth, outputHeight), /尚未完成/);
      for (const [id, element] of Object.entries(result.elements)) {
        assert.ok(Math.abs(replayed.elements[id].centerXPct - element.centerXPct) < 0.001, `${id} 重放后 X 不得漂移`);
        assert.ok(Math.abs(replayed.elements[id].centerYPct - element.centerYPct) < 0.001, `${id} 重放后 Y 不得漂移`);
      }
    }
  }
}

console.log('规范布局服务测试通过：真实 Chrome、四套模板、三种画幅、固定元素、输入与资源哈希。');

} finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
