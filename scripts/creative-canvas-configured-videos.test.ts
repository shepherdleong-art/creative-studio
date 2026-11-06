import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { configuredCanvasVideos } from '../lib/creative-canvas/adapters/configured-videos.ts';
import { canvasModelOptions } from '../lib/creative-canvas/model-options.ts';

const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE video_providers (id TEXT, name TEXT, type TEXT, defaultModel TEXT, baseUrl TEXT, apiKey TEXT, enabled INTEGER)`);
  const insert = db.prepare("INSERT INTO video_providers VALUES (?, ?, 'openai-video', ?, ?, ?, 1)");
  const fast = 'doubao-seedance-2-0-fast-260128';
  insert.run('company-seedance-2-0-fast', '即梦 Seedance 2.0 Fast', fast, 'https://fixture.invalid/v1', 'test-key');
  insert.run('jimeng-2-0', '即梦 2.0 (Seedance 2.0)', fast, 'https://fixture.invalid/v1/', 'test-key');
  insert.run('company-seedance-2-0', '即梦 Seedance 2.0', 'doubao-seedance-2-0-260128', 'https://fixture.invalid/v1', 'test-key');
  insert.run('different-account', '另一账号', fast, 'https://fixture.invalid/v1', 'different-key');
  insert.run('different-channel', '另一渠道', fast, 'https://other.invalid/v1', 'test-key');
  const models = configuredCanvasVideos(db);
  assert.equal(models.length, 5, '所有旧键仍可供执行和恢复使用');
  assert.equal(canvasModelOptions(models).length, 4, '只合并精确模型、协议、地址与凭据均相同的配置');
  const legacy = models.find(model => model.providerIdentity === 'jimeng-2-0')!;
  assert.equal(legacy.displayName, '即梦 Seedance 2.0 Fast');
  assert.ok(legacy.selectionAliasOf);
  const options = canvasModelOptions(models, legacy.key);
  assert.equal(options.length, 4);
  assert.ok(options.some(model => model.key === legacy.key));
  assert.ok(!options.some(model => model.key === legacy.selectionAliasOf));
  assert.ok(!JSON.stringify(models).includes('test-key'));
  assert.ok(!JSON.stringify(models).includes('fixture.invalid'));
  db.prepare("UPDATE video_providers SET enabled = 0 WHERE id = 'company-seedance-2-0-fast'").run();
  assert.equal(configuredCanvasVideos(db).find(model => model.providerIdentity === 'jimeng-2-0')?.selectionAliasOf, undefined);
  console.log('PASS: duplicate video configuration options and historical canvas selection');
} finally { db.close(); }
