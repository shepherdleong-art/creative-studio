import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { extractAssetFilenameDescriptions, parseFilenameDescription } from '../lib/batch-production/filename-analysis.ts';
import { registerManagedCopy, registerLinkedSource } from '../lib/batch-production/media-catalog.ts';
import { createAnalysisVersionAndSetCurrent, getAsset, markAssetArchived } from '../lib/batch-production/assets.ts';
import { getCurrentAssetAnalysis, queueAssetPreparation } from '../lib/batch-production/asset-preparation.ts';
import { buildBatchScenes, batchSemanticPoolKey } from '../lib/batch-production/semantic-match.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion } from '../lib/batch-production/versions.ts';

const parsed = parseFilenameDescription('C:\\素材\\G1_钩子镜头_悬念-抗造_单人出镜_成人全力跳坐.MP4');
assert.equal(parsed.filename, 'G1_钩子镜头_悬念-抗造_单人出镜_成人全力跳坐.MP4');
assert.equal(parsed.description, '钩子镜头，悬念，抗造，单人出镜，成人全力跳坐');
assert.deepEqual(parsed.labels, ['钩子镜头', '悬念', '抗造', '单人出镜', '成人全力跳坐']);
assert.ok(parseFilenameDescription('G6_防污_无人出镜-液体喷溅.mp4').labels.includes('无人出镜'));
assert.ok(parseFilenameDescription('cat-scratch_test.MOV').labels.includes('scratch'));
for (const name of ['.mp4', 'G1.MP4', 'IMG_1234.mp4', '202609161234.mp4', 'a'.repeat(64) + '.mp4']) {
  assert.throws(() => parseFilenameDescription(name), /缺少内容描述/);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-filename-analysis-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO projects VALUES ('p1', '项目一'), ('p2', '项目二');`);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('文件名提取禁止网络请求'); };
try {
  assert.equal((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'ready');
  const source = path.join(root, 'test.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:duration=0.5:size=64x64:rate=24', '-pix_fmt', 'yuv420p', '-y', source]);
  const id = await registerManagedCopy(db, 'p1', { sourcePath: source, displayName: parsed.filename });
  const oldAnalysisId = createAnalysisVersionAndSetCurrent(db, {
    assetId: id, analyzerVersion: 'technical', providerId: 'ffprobe', model: 'ffprobe',
    analysisJson: { analysisLevel: 'technical', durationUs: 500000 },
  });
  const batchId = createBatchProduction(db, 'p1', '历史批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  addAssetToPool(db, versionId, { assetId: id, analysisId: oldAnalysisId });
  db.prepare("UPDATE batch_production_versions SET inputState = 'frozen' WHERE id = ?").run(versionId);
  const foreign = await registerLinkedSource(db, 'p2', { filePath: source, displayName: 'G2_猫抓皮面无痕.mp4' });
  await assert.rejects(() => extractAssetFilenameDescriptions(db, 'p1', [id, foreign]), /素材不存在/);
  assert.equal(getAsset(db, 'p1', id)?.currentAnalysisId, oldAnalysisId, '跨项目请求不能部分写入');

  const result = await extractAssetFilenameDescriptions(db, 'p1', [id, id]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 1);
  const analysis = getCurrentAssetAnalysis(db, 'p1', id)!;
  assert.equal(analysis.analysisSource, 'filename');
  assert.equal(analysis.filenameDescription, parsed.description);
  assert.equal(analysis.providerId, 'local-filename');
  assert.equal(analysis.analysisLevel, 'content');
  assert.notEqual(analysis.id, oldAnalysisId);
  assert.equal((db.prepare('SELECT analysisId FROM batch_asset_pool_items WHERE batchVersionId = ?').get(versionId) as { analysisId: string }).analysisId, oldAnalysisId);
  const scenes = buildBatchScenes([{ assetId: id, contentFingerprint: 'fp', analysisJson: analysis.analysisJson }]);
  assert.equal(scenes.length, 1, '文件名描述进入现有匹配场景');
  assert.equal(scenes[0].description, parsed.description);
  assert.equal(scenes[0].startUs, 0);
  assert.equal(scenes[0].endUs, 500000);
  assert.equal(scenes[0].quality, 0.5, '不虚构画质评分');
  const again = await extractAssetFilenameDescriptions(db, 'p1', [id]);
  assert.equal(again.items[0].analysisId, analysis.id);
  assert.equal(again.items[0].reused, true);
  assert.equal(queueAssetPreparation(db, 'p1', batchId, [id], undefined, { mode: 'content', providerId: 'unused', model: 'unused' }).items[0].ready, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM batch_tasks').get() as { n: number }).n, 0);

  const metadata = JSON.parse((db.prepare('SELECT mediaJson FROM batch_assets WHERE id = ?').get(id) as { mediaJson: string }).mediaJson) as Record<string, unknown>;
  db.prepare('UPDATE batch_assets SET mediaJson = ? WHERE id = ?').run(JSON.stringify({ ...metadata, displayName: 'G9_防污_液体喷溅.mp4' }), id);
  const changed = await extractAssetFilenameDescriptions(db, 'p1', [id]);
  assert.notEqual(changed.items[0].analysisId, analysis.id);
  assert.notEqual(batchSemanticPoolKey(scenes), batchSemanticPoolKey(buildBatchScenes([{ assetId: id, contentFingerprint: 'fp', analysisJson: getCurrentAssetAnalysis(db, 'p1', id)!.analysisJson }])));
  const linked = await extractAssetFilenameDescriptions(db, 'p2', [foreign]);
  assert.equal(linked.items[0].description, '猫抓皮面无痕');
  const visionId = createAnalysisVersionAndSetCurrent(db, { assetId: foreign, analyzerVersion: 'vision', providerId: 'vision', model: 'vision', analysisJson: { analysisLevel: 'content', analyzer: 'vision' } });
  assert.match((await extractAssetFilenameDescriptions(db, 'p2', [foreign])).errors[0].message, /保留原分析/);
  assert.equal(getAsset(db, 'p2', foreign)?.currentAnalysisId, visionId);
  markAssetArchived(db, 'p1', id);
  assert.match((await extractAssetFilenameDescriptions(db, 'p1', [id])).errors[0].message, /离线或归档/);
  const blueSource = path.join(root, 'blue.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:duration=0.5:size=64x64:rate=24', '-pix_fmt', 'yuv420p', '-y', blueSource]);
  const blueId = await registerLinkedSource(db, 'p1', { filePath: blueSource, displayName: 'G3_防污_液体喷溅.MP4' });
  const pending = queueAssetPreparation(db, 'p1', batchId, [blueId]);
  assert.match((await extractAssetFilenameDescriptions(db, 'p1', [blueId])).errors[0].message, /任务尚未结束/);
  assert.equal(getAsset(db, 'p1', blueId)?.currentAnalysisId, null, '不与正在执行的分析争抢当前版本');
  db.prepare("UPDATE batch_tasks SET status = 'cancelled' WHERE id = ?").run(pending.items[0].taskId);
  const partial = await extractAssetFilenameDescriptions(db, 'p1', [id, blueId]);
  assert.equal(partial.errors.length, 1);
  assert.equal(partial.items[0].assetId, blueId, '单条失败不阻塞其余素材');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => extractAssetFilenameDescriptions(db, 'p1', [blueId], aborted.signal), { name: 'AbortError' });
  assert.equal(networkCalls, 0, '全程不得调用视觉或文字模型');
  console.log('batch filename analysis tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
