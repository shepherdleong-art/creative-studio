import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizeProductionCode, packagingCode, withProductionCodes } from '../lib/media-core/production-codes.ts';
import { resolveRevisionScriptCode, resolveScriptCode, resolveTemplateOpeningCode, resolveVideoOpeningCode } from '../lib/media-core/production-code-reader.ts';
import { readBatchProductionCodes } from '../lib/batch-production/production-codes.ts';
import { reserveProjectExportTarget, publishReservedExportTarget } from '../lib/final-edit/export-naming.ts';
import { reserveBatchExportTarget } from '../lib/batch-production/batch-export.ts';
import { publishUnpackagedRender } from '../lib/final-edit/publish-original.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-codes-'));
const db = new Database(':memory:');
try {
  assert.equal(normalizeProductionCode(' ｊ１ ', 'J'), 'J1');
  for (const invalid of ['J0', 'J01', 'J-1', 'J1/../../', 'J1000000', 'K1']) {
    assert.equal(normalizeProductionCode(invalid, 'J'), '');
  }
  assert.equal(packagingCode({ enabled: false, template: 'overlay-poster' }), '');
  assert.equal(packagingCode({ enabled: true, template: 'overlay-variety' }), 'D');
  assert.equal(withProductionCodes('基础名', { scriptCode: 'J1', openingCode: 'K2', packagingCode: 'A' }), '基础名-J1K2A');
  assert.equal(withProductionCodes('基础名', {}), '基础名');

  db.exec(`
    CREATE TABLE video_prompt_templates (id TEXT PRIMARY KEY, openingCode TEXT);
    CREATE TABLE video_jobs (id TEXT PRIMARY KEY, projectId TEXT, shotSetId TEXT, templateId TEXT, openingCode TEXT);
    INSERT INTO video_prompt_templates VALUES ('magic-growth', 'K1'), ('slow-push-in', NULL);
    INSERT INTO video_jobs VALUES ('legacy', 'p1', 'ss1', 'magic-growth', NULL), ('none', 'p1', 'ss1', 'magic-growth', '');
    CREATE TABLE script_studio_viral_tpl_libraries (currentRevisionId TEXT);
    CREATE TABLE script_studio_viral_tpl_entries (revisionId TEXT, sourceTemplateId TEXT, rawColumnsJson TEXT);
    INSERT INTO script_studio_viral_tpl_libraries VALUES ('r2');
    INSERT INTO script_studio_viral_tpl_entries VALUES ('r1', 'bed', '{"scriptCode":"J8"}'), ('r2', 'bed', '{"scriptCode":"J1"}');
  `);
  assert.equal(resolveScriptCode(db, { templateRewrite: { sourceTemplateId: 'bed' } }), 'J1');
  assert.equal(resolveScriptCode(db, { templateRewrite: { sourceTemplateId: 'bed', scriptCode: 'J8' } }), 'J8');
  assert.equal(resolveScriptCode(db, { templateRewrite: { sourceTemplateId: 'bed', scriptCode: '' } }), '');
  assert.equal(resolveScriptCode(db, { title: 'bed J1' }), '', '不得从标题猜编号');
  db.exec(`CREATE TABLE project_scripts (id TEXT, projectId TEXT);
    CREATE TABLE project_script_revisions (id TEXT, scriptId TEXT, contentJson TEXT);
    INSERT INTO project_scripts VALUES ('s1', 'p1');
    INSERT INTO project_script_revisions VALUES ('old', 's1', '{"templateRewrite":{"sourceTemplateId":"bed"}}'),
      ('new', 's1', '{"templateRewrite":{"sourceTemplateId":"another","scriptCode":"J9"}}');`);
  assert.equal(resolveRevisionScriptCode(db, 'p1', 'old'), 'J1');
  assert.equal(resolveRevisionScriptCode(db, 'p2', 'old'), '');
  const frozenOpening = resolveTemplateOpeningCode(db, 'magic-growth');
  db.prepare('INSERT INTO video_jobs VALUES (?, ?, ?, ?, ?)').run('frozen', 'p1', 'ss1', 'magic-growth', frozenOpening);
  db.prepare("UPDATE video_prompt_templates SET openingCode='K9' WHERE id='magic-growth'").run();
  assert.equal(resolveTemplateOpeningCode(db, 'magic-growth'), 'K9');
  assert.equal(resolveVideoOpeningCode(db, 'p1', 'frozen', 'ss1'), 'K1', '修改提示词编号不改变已生成视频');
  assert.equal(resolveVideoOpeningCode(db, 'p1', 'legacy', 'ss1'), 'K1');
  assert.equal(resolveVideoOpeningCode(db, 'p1', 'none', 'ss1'), '');
  assert.equal(resolveVideoOpeningCode(db, 'p2', 'frozen'), '');
  assert.equal(resolveVideoOpeningCode(db, 'p1', 'frozen', 'ss2'), '');
  assert.equal(resolveTemplateOpeningCode(db, 'slow-push-in'), '');

  db.exec(`
    CREATE TABLE batch_script_snapshots (id TEXT, scriptCode TEXT);
    CREATE TABLE batch_output_plans (id TEXT, scriptSnapshotId TEXT, batchVersionId TEXT);
    CREATE TABLE batch_output_versions (id TEXT, planId TEXT);
    CREATE TABLE batch_production_versions (id TEXT, batchId TEXT);
    CREATE TABLE batch_productions (id TEXT, projectId TEXT);
    CREATE TABLE batch_assets (id TEXT, projectId TEXT);
    CREATE TABLE batch_asset_sources (assetId TEXT, sourceKind TEXT, locationJson TEXT);
    INSERT INTO batch_script_snapshots VALUES ('script', 'J1');
    INSERT INTO batch_output_plans VALUES ('plan', 'script', 'version');
    INSERT INTO batch_output_versions VALUES ('out', 'plan');
    INSERT INTO batch_production_versions VALUES ('version', 'batch');
    INSERT INTO batch_productions VALUES ('batch', 'p1');
    INSERT INTO batch_assets VALUES ('opening', 'p1'), ('body', 'p1');
    INSERT INTO batch_asset_sources VALUES ('opening', 'module4', '{"kind":"module4","videoJobId":"frozen","shotSetId":"ss1"}');
  `);
  const batchInput = { projectId: 'p1', planId: 'plan', outputVersionId: 'out', firstAssetId: 'opening', packaging: { enabled: true, template: 'overlay-journal' } };
  assert.deepEqual(readBatchProductionCodes(db, batchInput), { scriptCode: 'J1', openingCode: 'K1', packagingCode: 'B' });
  assert.equal(readBatchProductionCodes(db, { ...batchInput, firstAssetId: 'body' }).openingCode, '', '换成无来源的首段时不能保留旧 K 编号');
  assert.equal(readBatchProductionCodes(db, { ...batchInput, projectId: 'p2' }).scriptCode, '');
  db.prepare('INSERT INTO batch_asset_sources VALUES (?, ?, ?)').run('opening', 'module4', JSON.stringify({ kind: 'module4', videoJobId: 'none', shotSetId: 'ss1' }));
  assert.equal(readBatchProductionCodes(db, batchInput).openingCode, '', '冲突来源不得猜测');

  const baseName = '20261014-X店-型号-AI种草-剪辑师';
  const identity = { projectId: 'p1', taskName: '测试', taskDate: '20261014', productCode: '型号', exportDirName: 'p1', baseName, productionCodes: { scriptCode: 'J1', openingCode: 'K2', packagingCode: 'A' } };
  const single = reserveProjectExportTarget(root, identity);
  const batch = reserveBatchExportTarget({ ...identity, storageRoot: root, batchId: 'batch', planSeq: 9, outputVersion: 1 });
  assert.equal(single.videoFilename, `${baseName}-J1K2A.mp4`);
  assert.equal(batch.videoFilename, `${baseName}-J1K2A-02.mp4`, '单条和批量共享防覆盖序号');
  assert.equal(reserveProjectExportTarget(root, identity).videoFilename, `${baseName}-J1K2A-03.mp4`);
  fs.writeFileSync(path.join(root, 'raw.mp4'), '原片');
  fs.writeFileSync(path.join(root, 'raw.jpg'), '原片封面');
  await publishReservedExportTarget({ storageRoot: root, target: single, internalVideoRelativePath: 'raw.mp4', internalCoverRelativePath: 'raw.jpg' });
  assert.equal(reserveProjectExportTarget(root, identity).videoFilename, `${baseName}-J1K2A-04.mp4`);
  const skip = await publishUnpackagedRender({ storageRoot: root, target: reserveProjectExportTarget(root, identity), identity, videoRelativePath: 'raw.mp4', coverRelativePath: 'raw.jpg' });
  assert.equal(skip.videoFilename, `${baseName}-J1K2.mp4`, '发布原片必须去掉包装标记');
  assert.equal(skip.coverFilename, `${baseName}-J1K2-封面.jpg`);
  assert.equal(fs.readFileSync(path.join(root, skip.videoRelativePath), 'utf8'), '原片');
  assert.equal(fs.readFileSync(path.join(root, single.videoRelativePath), 'utf8'), '原片', '已有导出不得覆盖');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('production codes tests passed');
