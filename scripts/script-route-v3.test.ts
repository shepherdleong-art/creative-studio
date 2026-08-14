import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ScriptOutputV3 } from '../lib/script-providers/types.ts';

const { generateAndPersistScriptV3 } = await import('../lib/script-generation-v3-service.ts');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-route-v3-'));
const storageRoot = path.join(tempRoot, 'storage');
const imageDir = path.join(storageRoot, 'script-test-images');
fs.mkdirSync(imageDir, { recursive: true });
const sourceImagePath = path.join(imageDir, 'source.png');
const fallbackSourceImagePath = path.join(imageDir, 'fallback-source.webp');
const generatedImagePath = path.join(imageDir, 'generated.jpg');
fs.writeFileSync(sourceImagePath, Buffer.from('source-image'));
fs.writeFileSync(fallbackSourceImagePath, Buffer.from('fallback-source-image'));
fs.writeFileSync(generatedImagePath, Buffer.from('generated-image'));

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, path TEXT NOT NULL, mimeType TEXT NOT NULL
  );
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, indexNum INTEGER NOT NULL,
    sourceImageId TEXT NOT NULL, latestGeneratedImageId TEXT
  );
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, inputSnapshot TEXT NOT NULL, outputJson TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO shot_sets (id, projectId, name) VALUES
    ('set-owned', 'project-a', '当前分镜组'),
    ('set-empty', 'project-a', '空分镜组'),
    ('set-foreign', 'project-b', '其他项目');
  INSERT INTO projects (id, name) VALUES ('project-a', '项目A'), ('project-b', '项目B');
`);
db.prepare(`INSERT INTO image_assets (id, filename, path, mimeType) VALUES (?, ?, ?, ?)`).run(
  'image-source', 'source.png', sourceImagePath, 'image/png',
);
db.prepare(`INSERT INTO image_assets (id, filename, path, mimeType) VALUES (?, ?, ?, ?)`).run(
  'image-generated', 'generated.jpg', generatedImagePath, 'image/jpeg',
);
db.prepare(`INSERT INTO image_assets (id, filename, path, mimeType) VALUES (?, ?, ?, ?)`).run(
  'image-fallback-source', 'fallback-source.webp', fallbackSourceImagePath, 'image/webp',
);
db.prepare(`INSERT INTO image_assets (id, filename, path, mimeType) VALUES (?, ?, ?, ?)`).run(
  'image-missing-generated', 'missing-generated.png', path.join(imageDir, 'missing-generated.png'), 'image/png',
);
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES (?, ?, ?, ?, ?)`).run(
  'shot-owned', 'set-owned', 1, 'image-source', 'image-generated',
);
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId) VALUES (?, ?, ?, ?, ?)`).run(
  'shot-fallback', 'set-owned', 2, 'image-fallback-source', 'image-missing-generated',
);

const script: ScriptOutputV3 = {
  version: 3,
  title: '下班后的云感支撑',
  coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托', source: 'model' },
  platform: '小红书',
  tone: '温柔种草',
  templateId: 'scene_seeding',
  template: '场景种草',
  shotSetId: 'set-owned',
  targetDurationSec: 15,
  targetNarrationDurationSec: 14.166666666666666,
  contentCharacterCount: 55,
  estimatedNarrationDurationSec: 55 / 4.2,
  durationStatus: 'qualified',
  durationPolicyVersion: 'zh-tts-budget-v1',
  segments: [{
    id: 'segment-1', narration: '带标点的自然口播。', subtitle: '带标点的自然口播',
    sellingPointRefs: ['112°承托'], visualIntent: '靠背承托特写', visualKeywords: ['承托'],
  }],
  fullScript: '带标点的自然口播。',
  fullSubtitle: '带标点的自然口播',
};

const project = {
  name: '沙发项目', productName: '云感沙发', productCode: 'SF-A1', productCategory: '家具',
  targetAudience: '久坐上班族', scriptTone: '温柔种草', scriptPlatform: '小红书',
  sellingPointsJson: '[{"title":"112°承托"}]',
};

let receivedInput: object | null = null;
let receivedSignal: AbortSignal | undefined;
const generationController = new AbortController();
const serviceProgress: Array<{ phase: string; percent: number }> = [];
const response = await generateAndPersistScriptV3({
  projectId: 'project-a',
  project,
  body: {
    shotSetId: 'set-owned',
    selectedSellingPoints: [{ title: '112°承托', priority: 'highest', reason: '真实卖点' }],
    templateId: 'scene_seeding',
    targetDurationSec: 15,
    providerId: 'fake-provider',
  },
}, {
  db,
  storageRoot,
  signal: generationController.signal,
  onProgress: (progress) => serviceProgress.push(progress),
  createId: () => 'draft-v3',
  providerMeta: () => ({
    id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
    apiStyle: 'openai-compatible', supportsVision: true,
  }),
  completeJson: async () => ({}),
  prepareVisualImage: async ({ imageBuffer, mimeType }) => ({
    imageBuffer,
    mimeType: mimeType as 'image/jpeg',
    width: 1,
    height: 1,
    originalSizeBytes: imageBuffer.length,
    processedSizeBytes: imageBuffer.length,
  }),
  generate: async (input, generatorDependencies) => {
    receivedInput = input;
    receivedSignal = generatorDependencies.signal;
    return { script, attempts: 2 };
  },
});

assert.equal(response.status, 200);
assert.equal(receivedSignal, generationController.signal, '服务层必须把取消信号传给模型生成器');
assert.equal(serviceProgress[0]?.phase, 'preparing');
assert.ok(serviceProgress.some((progress) => progress.phase === 'saving'));
assert.deepEqual(serviceProgress.at(-1), {
  phase: 'completed', percent: 100, message: '脚本生成完成',
});
const visualInput = receivedInput as { visuals?: Array<Record<string, unknown>> } | null;
assert.deepEqual(visualInput?.visuals, [{
  shotId: 'shot-owned',
  shotIndex: 1,
  imageAssetId: 'image-generated',
  sourceFilename: 'generated.jpg',
  mimeType: 'image/jpeg',
  imageBase64: Buffer.from('generated-image').toString('base64'),
}, {
  shotId: 'shot-fallback',
  shotIndex: 2,
  imageAssetId: 'image-fallback-source',
  sourceFilename: 'fallback-source.webp',
  mimeType: 'image/webp',
  imageBase64: Buffer.from('fallback-source-image').toString('base64'),
}], 'V3 必须优先读取最新生成图，并在该文件缺失时回退同分镜源图');
assert.deepEqual(response.body, {
  draftId: 'draft-v3', script, provider: 'fake-provider', model: 'fake-model', attempts: 2,
});
const row = db.prepare(`SELECT inputSnapshot, outputJson FROM script_drafts WHERE id='draft-v3'`).get() as {
  inputSnapshot: string;
  outputJson: string;
};
const snapshot = JSON.parse(row.inputSnapshot) as Record<string, unknown>;
assert.equal(snapshot.shotSetId, 'set-owned');
assert.equal(snapshot.durationPolicyVersion, 'zh-tts-budget-v1');
assert.deepEqual(snapshot.targetCharacterRange, [54, 59]);
assert.equal('imageBase64' in snapshot, false);
assert.equal(snapshot.visualCount, 2);
assert.deepEqual(snapshot.visualImageAssetIds, ['image-generated', 'image-fallback-source']);
assert.deepEqual(JSON.parse(row.outputJson), script);

let nonVisionGenerateCalled = false;
const nonVisionResponse = await generateAndPersistScriptV3({
  projectId: 'project-a', project,
  body: { shotSetId: 'set-owned', templateId: 'scene_seeding', targetDurationSec: 15, providerId: 'text-only' },
}, {
  db,
  storageRoot,
  completeJson: async () => ({}),
  providerMeta: () => ({
    id: 'text-only', name: 'Text only', model: 'text-model', configured: true,
    apiStyle: 'openai-compatible', supportsVision: false,
  }),
  generate: async () => {
    nonVisionGenerateCalled = true;
    return { script, attempts: 1 };
  },
});
assert.equal(nonVisionResponse.status, 400);
assert.equal(nonVisionResponse.body.error, '所选生成模型不支持图片理解，请选择已启用视觉能力的脚本模型');
assert.equal(nonVisionGenerateCalled, false);

const preprocessingCancellation = new AbortController();
let cancelledPrepareCalls = 0;
let cancelledGenerateCalled = false;
await assert.rejects(
  generateAndPersistScriptV3({
    projectId: 'project-a', project,
    body: { shotSetId: 'set-owned', templateId: 'scene_seeding', targetDurationSec: 15, providerId: 'fake-provider' },
  }, {
    db,
    storageRoot,
    signal: preprocessingCancellation.signal,
    completeJson: async () => ({}),
    providerMeta: () => ({
      id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
      apiStyle: 'openai-compatible', supportsVision: true,
    }),
    prepareVisualImage: async () => {
      cancelledPrepareCalls += 1;
      preprocessingCancellation.abort();
      throw new DOMException('脚本生成已取消', 'AbortError');
    },
    generate: async () => {
      cancelledGenerateCalled = true;
      return { script, attempts: 1 };
    },
  }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
assert.equal(cancelledPrepareCalls, 1, '图片预处理取消后不能继续尝试备用图片');
assert.equal(cancelledGenerateCalled, false);

const emptyResponse = await generateAndPersistScriptV3({
  projectId: 'project-a', project,
  body: { shotSetId: 'set-empty', templateId: 'scene_seeding', targetDurationSec: 15, providerId: 'fake-provider' },
}, {
  db,
  storageRoot,
  completeJson: async () => ({}),
  providerMeta: () => ({
    id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
    apiStyle: 'openai-compatible', supportsVision: true,
  }),
  generate: async () => ({ script, attempts: 1 }),
});
assert.equal(emptyResponse.status, 400);
assert.equal(emptyResponse.body.error, '所选分镜组中没有可读取的分镜图片');

const foreignResponse = await generateAndPersistScriptV3({
  projectId: 'project-a', project,
  body: { shotSetId: 'set-foreign', templateId: 'scene_seeding', targetDurationSec: 15 },
}, {
  db,
  storageRoot,
  completeJson: async () => ({}),
  providerMeta: () => undefined,
  generate: async () => ({ script, attempts: 1 }),
});
assert.equal(foreignResponse.status, 400);
assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM script_drafts`).get() as { count: number }).count, 1);

// 迟到结果不落库：上游忽略 abort、稍后才正常返回时，服务层门禁必须拦截，不写草稿。
const lateController = new AbortController();
await assert.rejects(
  generateAndPersistScriptV3({
    projectId: 'project-a', project,
    body: { shotSetId: 'set-owned', templateId: 'scene_seeding', targetDurationSec: 15, providerId: 'fake-provider' },
  }, {
    db,
    storageRoot,
    signal: lateController.signal,
    completeJson: async () => ({}),
    providerMeta: () => ({
      id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
      apiStyle: 'openai-compatible', supportsVision: true,
    }),
    prepareVisualImage: async ({ imageBuffer, mimeType }) => ({
      imageBuffer, mimeType: mimeType as 'image/jpeg', width: 1, height: 1,
      originalSizeBytes: imageBuffer.length, processedSizeBytes: imageBuffer.length,
    }),
    generate: async () => {
      lateController.abort(); // 模拟取消发生在模型调用期间，但上游忽略 abort 正常返回
      return { script, attempts: 1 };
    },
  }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS count FROM script_drafts`).get() as { count: number }).count,
  1,
  '上游忽略 abort 的迟到结果不得写入草稿',
);

// 项目在生成中被删除：持久化前重验发现项目不存在，返回稳定错误码且不写草稿。
const deletedProjectResponse = await generateAndPersistScriptV3({
  projectId: 'project-a', project,
  body: { shotSetId: 'set-owned', templateId: 'scene_seeding', targetDurationSec: 15, providerId: 'fake-provider' },
}, {
  db,
  storageRoot,
  completeJson: async () => ({}),
  providerMeta: () => ({
    id: 'fake-provider', name: 'Fake', model: 'fake-model', configured: true,
    apiStyle: 'openai-compatible', supportsVision: true,
  }),
  prepareVisualImage: async ({ imageBuffer, mimeType }) => ({
    imageBuffer, mimeType: mimeType as 'image/jpeg', width: 1, height: 1,
    originalSizeBytes: imageBuffer.length, processedSizeBytes: imageBuffer.length,
  }),
  generate: async () => {
    db.prepare(`DELETE FROM projects WHERE id = 'project-a'`).run(); // 模拟生成期间项目被删除
    return { script, attempts: 1 };
  },
});
assert.equal(deletedProjectResponse.status, 422);
assert.equal(deletedProjectResponse.body.error, 'project_deleted');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS count FROM script_drafts`).get() as { count: number }).count,
  1,
  '项目已删除时不得写入草稿',
);
db.prepare(`INSERT INTO projects (id, name) VALUES ('project-a', '项目A')`).run();

db.close();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('script route v3 tests passed');
