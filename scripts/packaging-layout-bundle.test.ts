// node scripts/packaging-layout-bundle.test.ts — 缓存身份、原地修改与受控冻结预览回归。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PackagingLayoutResolution } from '../lib/media-core/packaging-auto-layout.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-bundle-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const packaging = path.join(root, 'live');
process.env.CREATIVE_STUDIO_PACKAGING_DIR = packaging;
function write(file: string, value: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
const chrome = `runtime/chrome-headless-shell/${process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'}`;
for (const file of [chrome, 'runtime/chrome-headless-shell/resources.pak', 'package-video.mjs', 'win-hide-spawn.cjs',
  'layout-service.mjs', 'auto-layout/runtime.js', 'auto-layout/replay.js', 'stickers/runtime.js', 'fonts/shared.ttf']) write(path.join(packaging, file), `original:${file}`);
write(path.join(packaging, 'node_modules/hyperframes/package.json'), '{"version":"0.8.134"}');
write(path.join(packaging, 'node_modules/hyperframes/bin/hyperframes.mjs'), 'original engine');
write(path.join(packaging, 'stickers/catalog.json'), '{"assets":[]}');
write(path.join(packaging, 'templates/overlay-poster/index.html'), '<html><head></head><body></body></html>');
write(path.join(root, 'storage/packaging/fonts/user-point-test.ttf'), 'original font');
const { materializePackagingLayoutBundle, assertPackagingLayoutExportReady, packagingLayoutEngineExecutable } = await import('../lib/media-core/packaging-layout-manifest.ts');
const { packagingPreviewHtml } = await import('../lib/media-core/packaging-preview.ts');
const { packagingPreviewAssetResponse, packagingPreviewResources } = await import('../lib/media-core/packaging-preview-resources.ts');
const config = { enabled: true, template: 'overlay-poster' as const, varsOverrides: {}, layoutRuntimeBundleVersion: 2,
  pointFont: { family: 'Test font', file: 'user-point-test.ttf' } };
try {
  const originalReadStream = fs.createReadStream;
  let mutated = false;
  fs.createReadStream = (file, options) => {
    const stream = originalReadStream(file, options);
    if (!mutated && path.resolve(String(file)) === path.resolve(packaging, chrome)) {
      stream.once('end', () => { mutated = true; write(path.join(packaging, chrome), 'updated-after-first-digest'); });
    }
    return stream;
  };
  try {
    await assert.rejects(() => materializePackagingLayoutBundle({ config, outputWidth: 1080, outputHeight: 1440 }), /已变化或缺失/);
    assert.equal(mutated, true);
    assert.deepEqual(fs.readdirSync(path.join(root, 'storage/packaging/layout-engines')), [], '来源在冻结期间改变时不能发布半成品');
  } finally {
    fs.createReadStream = originalReadStream;
    write(path.join(packaging, chrome), `original:${chrome}`);
  }
  let heartbeat = 0;
  const heartbeatTimer = setInterval(() => { heartbeat += 1; }, 1);
  const first = await materializePackagingLayoutBundle({ config, outputWidth: 1080, outputHeight: 1440 });
  clearInterval(heartbeatTimer);
  assert.ok(heartbeat > 0, '首次冻结引擎必须让出事件循环，不能阻塞工作区轮询与编辑请求');
  const tall = await materializePackagingLayoutBundle({ config, outputWidth: 1080, outputHeight: 1920 });
  assert.notEqual(first.manifest.geometryManifestHash, tall.manifest.geometryManifestHash, '同资源不同画幅不得复用清单');
  const resolution = (bundle: typeof first): PackagingLayoutResolution => ({ schemaVersion: 1, status: 'resolved', inputHash: 'a'.repeat(64),
    runtimeBundleVersion: 2, geometryManifestHash: bundle.manifest.geometryManifestHash, outputWidth: bundle.manifest.outputWidth,
    outputHeight: bundle.manifest.outputHeight, elements: {}, validation: { frameCount: 24, digest: 'test' } });
  for (const bundle of [first, tall]) assert.ok(await assertPackagingLayoutExportReady({ ...config, layoutResolution: resolution(bundle) }, bundle.manifest.outputWidth, bundle.manifest.outputHeight));
  const saved = { ...config, layoutResolution: resolution(first) };
  await assert.rejects(() => assertPackagingLayoutExportReady({ ...saved, layoutRuntimeBundleVersion: 3 }, 1080, 1440), /不支持/);
  assert.throws(() => packagingPreviewHtml({ config: { ...saved, layoutRuntimeBundleVersion: 3 },
    vars: { title: '', subtitle: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' }, totalSec: 3, coverSec: 20 / 24 }), /不支持/);
  const hash = saved.layoutResolution.geometryManifestHash;
  const frozenChrome = packagingLayoutEngineExecutable(first.manifest);
  const chromeBytes = fs.readFileSync(frozenChrome);
  // 原地写，而非 rename，能抓到硬链接伪冻结。
  write(path.join(packaging, chrome), 'changed chrome');
  write(path.join(packaging, 'runtime/chrome-headless-shell/resources.pak'), 'changed resource');
  write(path.join(packaging, 'templates/overlay-poster/index.html'), 'changed template');
  write(path.join(packaging, 'auto-layout/replay.js'), 'changed replay');
  write(path.join(root, 'storage/packaging/fonts/user-point-test.ttf'), 'changed font');
  assert.deepEqual(fs.readFileSync(frozenChrome), chromeBytes);
  assert.ok(await assertPackagingLayoutExportReady(saved, 1080, 1440));
  const vars = { title: '', subtitle: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' };
  const html = packagingPreviewHtml({ config: saved, vars, totalSec: 3, coverSec: 20 / 24, resourceUrl: '/authorized/resources' });
  assert.match(html, new RegExp(`/authorized/resources/${hash}/`));
  assert.ok(!html.includes('changed template'));
  assert.match(html, /fonts\/user\/user-point-test.ttf/);
  assert.equal(await packagingPreviewAssetResponse(saved, [hash, 'fonts', 'user', 'user-point-test.ttf']).text(), 'original font');
  assert.equal(await packagingPreviewAssetResponse(saved, [hash, 'auto-layout', 'replay.js']).text(), 'original:auto-layout/replay.js');
  for (const segments of [[tall.manifest.geometryManifestHash, 'fonts', 'shared.ttf'], [hash, '..', 'manifest.json'], [hash, 'manifest.json'], [hash, 'layout-service.mjs']]) {
    assert.throws(() => packagingPreviewAssetResponse(saved, segments));
  }
  const updated = await materializePackagingLayoutBundle({ config, outputWidth: 1080, outputHeight: 1440 });
  assert.notEqual(updated.manifest.geometryManifestHash, hash, '任一实际使用资源变化必须产生新快照');
  const current = { ...config, layoutResolution: resolution(updated) };
  packagingPreviewResources(saved, '/metadata-only/resources');
  assert.throws(() => packagingPreviewAssetResponse(current, [hash, 'auto-layout', 'replay.js'], '/metadata-only/resources'),
    /不存在/, '仅解析 JSON 预览的资源路径不能登记旧文档授权');
  assert.equal(await packagingPreviewAssetResponse(current, [hash, 'auto-layout', 'replay.js'], '/authorized/resources').text(),
    'original:auto-layout/replay.js', '配置切换后，已发出的同一成片文档必须能加载其原冻结资源');
  assert.equal(await packagingPreviewAssetResponse(current, [hash, 'fonts', 'user', 'user-point-test.ttf'], '/authorized/resources').text(),
    'original font', '已发出文档的字体也必须保持同源快照');
  assert.throws(() => packagingPreviewAssetResponse(current, [hash, 'auto-layout', 'replay.js'], '/another-film/resources'),
    /不存在/, '其他成片不能使用本成片的预览授权');
  assert.throws(() => packagingPreviewAssetResponse(current, [tall.manifest.geometryManifestHash, 'fonts', 'shared.ttf'], '/authorized/resources'),
    /不存在/, '存在于磁盘但未向该成片发出文档的旧快照不能访问');
  const updatedChrome = packagingLayoutEngineExecutable(updated.manifest);
  const engineManifestPath = path.join(path.dirname(path.dirname(updatedChrome)), 'manifest.json');
  const engineManifest = JSON.parse(fs.readFileSync(engineManifestPath, 'utf8'));
  write(updatedChrome, 'modified frozen engine');
  engineManifest.files[`chrome-headless-shell/${path.basename(updatedChrome)}`] = createHash('sha256').update('modified frozen engine').digest('hex');
  write(engineManifestPath, JSON.stringify(engineManifest));
  await assert.rejects(() => assertPackagingLayoutExportReady({ ...config, layoutResolution: resolution(updated) }, 1080, 1440), /不匹配/, '引擎与清单一起修改仍不能冒用旧引擎身份');
  write(path.join(first.bundleDir, 'auto-layout/replay.js'), 'tampered frozen');
  assert.throws(() => packagingPreviewAssetResponse(saved, [hash, 'auto-layout', 'replay.js']), /已变化/);
  assert.throws(() => packagingPreviewAssetResponse(current, [hash, 'auto-layout', 'replay.js'], '/authorized/resources'),
    /已变化/, '历史预览授权也必须重验每一份资源的摘要');
  await assert.rejects(() => assertPackagingLayoutExportReady(saved, 1080, 1440), /已变化/);
  console.log('布局冻结回归通过：多画幅、原地修改、引擎、字体、预览导出同源及路径边界。');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
