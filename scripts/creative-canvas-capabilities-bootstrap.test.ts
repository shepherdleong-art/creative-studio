import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { companyCanvasImageOutput } from '../lib/creative-canvas/adapters/company-image-output.ts';
import { ensureCanvasCapabilitiesRegistered } from '../lib/creative-canvas/capabilities-bootstrap.ts';
import { clearCanvasCapabilities, validateCapabilityInputs } from '../lib/creative-canvas/capabilities.ts';
import { resolveCompanyCanvasRoute } from '../lib/creative-canvas/adapters/company-providers.ts';

process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'company';
const db = new Database(':memory:');
db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, model TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER)`);
db.exec(`CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, defaultModel TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER)`);
const configured = [
  ['company-gateway-image2-medium', '腾讯image2-medium', 'image2-medium'],
  ['company-gateway-qiniuyun-gpt-image-2-medium', '七牛gpt-image-2-medium', 'qiniuyun/gpt-image-2-medium'],
  ['company-gateway-seedream-5-0-pro', 'Seedream 5.0 Pro', 'doubao-seedream-5-0-pro-image'],
  ['company-gateway-nano-banana-pro', 'Nano Banana Pro', 'nano-banana-3.0'],
  ['company-gateway-nano-banana-2', 'Nano Banana 2', 'nano-banana-3.1'],
];
for (const [id, name, model] of configured) {
  db.prepare(`INSERT INTO providers VALUES (?, ?, 'gateway-task-image', ?, 'http://127.0.0.1:4000', 'test-key', 1)`).run(id, name, model);
}
clearCanvasCapabilities();
const images = ensureCanvasCapabilitiesRegistered(db).filter((capability) => capability.mediaKind === 'image');
assert.deepEqual(images.map((capability) => capability.modelAlias).sort(), configured.map((row) => row[2]).sort(), '画布应列出设置里已启用且已支持的五个公司图片模型');
for (const [id, name, model] of configured) {
  const capability = images.find((entry) => entry.providerIdentity === id);
  assert.equal(capability?.displayName, name);
  assert.equal(capability?.modelAlias, model);
}
// 模拟用户本地视频配置：旧 ID 已改用不同渠道/模型，必须认实际字段。
const videos = [
  ['company-minimax-h3', 'minimax-h3'],
  ['company-wan-3-0', 'wan-3.0'],
  ['kling-2-5', 'kling-3.0'],
  ['jimeng-2-0', 'doubao-seedance-2-0-fast-260128'],
  ['company-seedance-2-0-fast', 'doubao-seedance-2-0-260128'],
  ['company-seedance-2-5', 'doubao-seedance-2-5-260628'],
  ['company-qiniuyun-kling-3-0', 'qiniuyun/kling-3.0'],
  ['company-kling-2-5', 'kling-2.5'],
];
for (const [id, model] of videos) {
  db.prepare(`INSERT INTO video_providers VALUES (?, ?, 'openai-video', ?, 'http://127.0.0.1:4000', 'test-key', 1)`).run(id, model, model);
}
const selected = ensureCanvasCapabilitiesRegistered(db).filter((capability) => capability.mediaKind === 'video');
assert.deepEqual(selected.map((capability) => capability.modelAlias).sort(), videos.map((row) => row[1]).sort());
for (const capability of selected) {
  assert.equal(capability.providerKind, 'company', 'openai-video 行不能误注册成方舟直连');
  const route = resolveCompanyCanvasRoute(db, { ...capability, mediaKind: 'video', expectedType: 'openai-video', exactModel: true });
  assert.equal(route.providerId, capability.providerIdentity);
}
const kling25 = selected.find((capability) => capability.modelAlias === 'kling-2.5')!;
for (const [model, min, max, resolution] of [['minimax-h3', 4, 15, '2K'], ['wan-3.0', 2, 30, '1080P']] as const) {
  const capability = selected.find((entry) => entry.modelAlias === model)!;
  const refs = [{ kind: 'image', role: 'first-frame' }, { kind: 'image', role: 'last-frame' }] as const;
  for (const durationSec of [min, max]) {
    assert.deepEqual(validateCapabilityInputs({ capability, mode: 'image-to-video', refs, parameters: { durationSec, resolution } }), []);
  }
  for (const durationSec of [min - 1, max + 1, min + 0.5]) {
    assert.ok(validateCapabilityInputs({ capability, mode: 'image-to-video', refs, parameters: { durationSec } }).some((problem) => problem.code === 'parameter_value_invalid'));
  }
  assert.ok(validateCapabilityInputs({ capability, mode: 'image-to-video', refs: [] }).length);
  assert.deepEqual(validateCapabilityInputs({ capability, mode: 'text-to-video', refs: [], parameters: { aspectRatio: '16:9' } }), []);
  assert.ok(validateCapabilityInputs({ capability, mode: 'text-to-video', refs }).length);
  assert.deepEqual(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: [{ kind: 'image', role: 'reference' }, { kind: 'audio', role: 'audio' }] }), []);
  assert.ok(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: [] }).length);
  assert.ok(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs }).length);
  assert.ok(validateCapabilityInputs({ capability, mode: 'image-to-video', refs, parameters: { multiShot: true } }).length);
  for (const resolutionOption of model === 'minimax-h3' ? ['768P', '2K'] : ['480P', '720P', '1080P']) {
    assert.deepEqual(validateCapabilityInputs({ capability, mode: 'image-to-video', refs, parameters: { resolution: resolutionOption } }), []);
  }
  assert.ok(validateCapabilityInputs({ capability, mode: 'image-to-video', refs, parameters: { resolution: '4K' } }).length);
  assert.ok(validateCapabilityInputs({ capability, mode: 'image-to-video', refs: [...refs, refs[1]] }).length);
}
assert.equal(validateCapabilityInputs({ capability: kling25, mode: 'text-to-video', refs: [], parameters: { durationSec: 6 } }).length, 1);
assert.equal(validateCapabilityInputs({ capability: kling25, mode: 'text-to-video', refs: [], parameters: { durationSec: 10 } }).length, 0);
db.prepare(`UPDATE providers SET enabled = 0 WHERE model = 'nano-banana-3.0'`).run();
db.prepare(`UPDATE providers SET apiKey = '' WHERE model = 'nano-banana-3.1'`).run();
db.prepare(`UPDATE video_providers SET enabled = 0 WHERE defaultModel = 'kling-3.0'`).run();
const refreshed = ensureCanvasCapabilitiesRegistered(db);
assert.equal(refreshed.filter((capability) => capability.mediaKind === 'image').length, 3, '停用和清空 Key 后不残留在模型列表');
assert.equal(refreshed.filter((capability) => capability.mediaKind === 'video').length, videos.length - 1);

db.prepare(`UPDATE video_providers SET enabled = 0 WHERE defaultModel = 'minimax-h3'`).run();
db.prepare(`UPDATE video_providers SET apiKey = '' WHERE defaultModel = 'wan-3.0'`).run();
assert.ok(!ensureCanvasCapabilitiesRegistered(db).some((entry) => ['minimax-h3', 'wan-3.0'].includes(entry.modelAlias)));
db.prepare(`INSERT INTO video_providers VALUES ('unknown-h3', 'Unknown H3', 'openai-video', 'minimax-h3-max', 'http://127.0.0.1:4000', 'test-key', 1)`).run();
assert.ok(!ensureCanvasCapabilitiesRegistered(db).some((entry) => entry.modelAlias === 'minimax-h3-max'));
db.prepare(`UPDATE providers SET name = '自定义名称' WHERE model = 'image2-medium'`).run();
assert.equal(ensureCanvasCapabilitiesRegistered(db).find((capability) => capability.key === 'company-image2-medium')?.displayName, '自定义名称');
db.prepare(`UPDATE providers SET model = 'unknown-image' WHERE model = 'image2-medium'`).run();
assert.ok(!ensureCanvasCapabilitiesRegistered(db).some((capability) => capability.key === 'company-image2-medium'));
assert.throws(() => resolveCompanyCanvasRoute(db, { providerIdentity: configured[0][0], modelAlias: 'image2-medium', mediaKind: 'image', exactModel: true }), /重新选择模型/);
db.close();
clearCanvasCapabilities();
const donor = await sharp({ create: { width: 216, height: 384, channels: 3, background: '#fff' } }).png().toBuffer();
const delivered = await companyCanvasImageOutput(donor, 'qiniuyun/gpt-image-2-medium', { aspectRatio: '3:4', resolution: '4K' });
const metadata = await sharp(delivered.bytes).metadata();
assert.deepEqual([metadata.width, metadata.height], [216, 288], '七牛排除格须裁回目标画幅，不缩放原生像素');
console.log('creative-canvas-capabilities-bootstrap tests passed');
