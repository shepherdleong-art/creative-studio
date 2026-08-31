import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { syncProjectScripts } from '../lib/batch-production/script-catalog.ts';
import { listReadableProjectScripts } from '../lib/media-core/project-script-reader.ts';
import { createTask, getTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask, parseTileRefIndex } from '../lib/script-studio/runner.ts';
import { buildDeterministicFallbackScript, type ScriptGenerator } from '../lib/script-studio/generator.ts';
import type { VisionExtractionResult, VisionExtractor } from '../lib/script-studio/adapters/vision-extract.ts';
import type { EvidenceReprobe } from '../lib/script-studio/adapters/reprobe.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-pipeline-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, role TEXT NOT NULL, filename TEXT NOT NULL,
    path TEXT NOT NULL, originalPath TEXT, mimeType TEXT NOT NULL,
    originalWidth INTEGER, originalHeight INTEGER
  );
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini',
    model TEXT NOT NULL DEFAULT '', inputSnapshot TEXT NOT NULL DEFAULT '{}',
    outputJson TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL
  );
  INSERT INTO projects (id, name) VALUES ('p1', '项目一');
  INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss1', 'p1', '组一', '2026-08-31T00:00:00.000Z');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'script-studio-backups'),
  now: () => new Date('2026-08-31T00:00:00.000Z'),
});
await ensureBatchSchemaReady({
  db,
  backupRoot: path.join(root, 'batch-backups'),
  now: () => new Date('2026-08-31T00:00:01.000Z'),
});

const imagePath = path.join(root, 'detail.png');
await sharpImage(imagePath);
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-1', 'p1', 'input', 'detail.png', ?, ?, 'image/png', 1200, 2400)
`).run(imagePath, imagePath);
db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('source-1', 'p1', 'fp-1', '["img-1"]', '2026-08-31T00:01:00.000Z')
`).run();

const vision: VisionExtractor = {
  async extract(): Promise<VisionExtractionResult> {
    return {
      productName: '测试产品',
      category: '家具',
      brand: '',
      providerId: 'fake',
      model: 'fake',
      promptContractVersion: 1,
      sellingPoints: [
        { title: '外观', factText: '外观简洁', pointType: 'appearance', evidenceQuote: '外观简洁', sourcePageIndex: 0, tileRefs: ['tile_1'], modelConfidence: 'medium', usable: true },
        { title: '材质', factText: '采用实木', pointType: 'material', evidenceQuote: '采用实木', sourcePageIndex: 0, tileRefs: ['tile_2'], modelConfidence: 'high', usable: true },
      ],
    };
  },
};
const reprobe: EvidenceReprobe = {
  kind: 'vision_closed_question',
  async verify(input) {
    return { quote: input.claim };
  },
};
const generator: ScriptGenerator = {
  async generate(input) {
    return { content: buildDeterministicFallbackScript(input), attempts: 1 };
  },
};

const task = createTask(db, {
  projectId: 'p1',
  requestKey: 'pipeline-request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 3, creativeBrief: '' },
  requestedCount: 3,
});
const result = await executeScriptStudioTask({
  db,
  projectId: 'p1',
  taskId: task.task.id,
  sourceSetId: 'source-1',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 3, creativeBrief: '' },
  visionExtractor: vision,
  reprobe,
  generator,
});
assert.equal(result.status, 'succeeded');
assert.equal(result.scriptIds.length, 3);
assert.equal(getTask(db, 'p1', task.task.id)?.status, 'succeeded');
assert.equal(listReadableProjectScripts(db, 'p1').filter((row) => row.kind === 'project').length, 3);

const syncResult = syncProjectScripts(db, 'p1');
assert.equal(syncResult.synced >= 3, true, '新项目脚本可以同步进批次脚本目录');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts WHERE sourceId LIKE 'project-script:%'`).get() as { n: number }).n,
  syncResult.scripts.length,
);

// tileRefs 编号解析：模型按 1-based "tile_N" 返回，兼容裸数字；解析失败不猜。
assert.equal(parseTileRefIndex('tile_8'), 7);
assert.equal(parseTileRefIndex('tile_1'), 0);
assert.equal(parseTileRefIndex('3'), 2);
assert.equal(parseTileRefIndex(3), 2);
assert.equal(parseTileRefIndex('tile_0'), null);
assert.equal(parseTileRefIndex('abc'), null);
assert.equal(parseTileRefIndex(0), null);

db.close();
console.log('script-studio-pipeline.test.ts: ok');

async function sharpImage(filePath: string): Promise<void> {
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 1200, height: 2400, channels: 3, background: '#ffffff' } }).png().toFile(filePath);
}
