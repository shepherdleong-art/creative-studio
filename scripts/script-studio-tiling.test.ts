import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { parseTileRefIndex, tileSourceImages, selectEvidenceTiles } from '../lib/script-studio/tiling.ts';
import { createOrFindSourceSet } from '../lib/script-studio/source-sets.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-tiling-'));
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
  INSERT INTO projects (id, name) VALUES ('p1', '项目一');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:00.000Z'),
});

const imagePath = path.join(root, 'detail.png');
await sharp({
  create: { width: 1800, height: 5200, channels: 3, background: '#ffffff' },
}).png().toFile(imagePath);
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-1', 'p1', 'input', 'detail.png', ?, ?, 'image/png', 1800, 5200)
`).run(imagePath, imagePath);

const result = await tileSourceImages(db, 'p1', ['img-1'], {
  limits: {
    maxImageWidth: 1024,
    baseTileHeight: 1024,
    verticalOverlapRatio: 0.12,
    jpegQuality: 88,
    maxImagesPerRequest: 2,
    sourcePixelLimit: 60_000_000,
    decodeBufferLimitBytes: 150 * 1024 * 1024,
    maxTokensPerPage: 8000,
    reprobeConcurrency: 3,
    reprobeBatchSize: 4,
    reprobeMaxImagesPerBatch: 6,
    extractTileBatchSize: 14,
    extractConcurrency: 3,
    extractRequestTimeoutMs: 120_000,
    extractMaxAttempts: 2,
    generationConcurrency: 2,
  },
});
assert.equal(result.pages.length, 1);
assert.ok(result.totalTiles > 1);
assert.ok(result.totalTiles <= 4, '单请求超限时应提高片高并明确降级');
assert.equal(result.degraded, true);
assert.equal(result.pages[0]!.tiles[0]!.mimeType, 'image/jpeg');
assert.equal(result.pages[0]!.tiles[0]!.imageBase64.length > 100, true);
assert.equal(selectEvidenceTiles(result.pages[0]!, 5, 1).length, 0, '越界证据切片不应越界');
assert.equal(selectEvidenceTiles(result.pages[0]!, 1, 1).length >= 2, true);
assert.equal(parseTileRefIndex('tile_2'), 1, 'tile_N 按 1-based 契约解析');
assert.equal(parseTileRefIndex('2'), 1, '纯数字字符串保持兼容');
assert.equal(parseTileRefIndex(2), 1, '纯数字输入保持兼容');
for (const invalidRef of ['garbage2', 'tile_2_evil', 'page_3', '2foo', 'tile_0', '0']) {
  assert.equal(parseTileRefIndex(invalidRef), null, `非法证据位置必须拒绝：${invalidRef}`);
}

// 超过保护值的大图：不再硬阻断，改走逐条带流式管线
const bigImagePath = path.join(root, 'detail-big.png');
await sharp({
  create: { width: 2000, height: 4000, channels: 3, background: '#eeeeee' },
}).png().toFile(bigImagePath);
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-2', 'p1', 'input', 'detail-big.png', ?, ?, 'image/png', 2000, 4000)
`).run(bigImagePath, bigImagePath);

const tightLimits = {
  maxImageWidth: 1024,
  baseTileHeight: 1024,
  verticalOverlapRatio: 0.12,
  jpegQuality: 88,
  maxImagesPerRequest: 50,
  sourcePixelLimit: 1_000_000,
  decodeBufferLimitBytes: 1_000_000,
  maxTokensPerPage: 8000,
  reprobeConcurrency: 3,
  reprobeBatchSize: 4,
  reprobeMaxImagesPerBatch: 6,
  extractTileBatchSize: 14,
  extractConcurrency: 3,
  extractRequestTimeoutMs: 120_000,
  extractMaxAttempts: 2,
  generationConcurrency: 2,
};
const bigResult = await tileSourceImages(db, 'p1', ['img-2'], { limits: tightLimits });
assert.equal(bigResult.pages.length, 1);
assert.ok(bigResult.totalTiles > 1, '大图也应正常切片');
for (const tile of bigResult.pages[0]!.tiles) {
  assert.equal(tile.width, 1024);
  assert.ok(tile.imageBase64.length > 100);
}

// 来源集创建对超限图片只提示不拒绝
const sourceSet = createOrFindSourceSet(db, 'p1', ['img-2'], { limits: tightLimits });
assert.equal(sourceSet.resourceReport.overResourceLimit, false, '超限图片不应再阻断来源集创建');
assert.ok(sourceSet.resourceReport.messages.length >= 1, '超限时应给出自动压缩提示');
assert.ok(sourceSet.sourceSetId.length > 0);

db.close();
console.log('script-studio-tiling.test.ts: ok');
