import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-projects-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys=ON');
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { createLiveMixcutProject, readLiveMixcutProject, listLiveMixcutProjects,
    updateLiveMixcutProject, deleteLiveMixcutProject } = await import('../lib/live-mixcut/projects.ts');
  const { getBatchProduction } = await import('../lib/live-mixcut/versions.ts');
  assert.equal((await checkBatchProductionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);

  const now = new Date('2026-10-24T01:02:03.000Z');
  const input = { storeCode: 'K店', productCode: 'XQ9A', editorName: '张三' };
  const first = createLiveMixcutProject(db, input, now);
  const second = createLiveMixcutProject(db, input, now);
  const baseName = '20261024-K店-XQ9A-实拍混剪-张三';
  assert.equal(first.name, baseName);
  assert.equal(first.productName, 'XQ9A');
  assert.equal(first.exportDirName, baseName);
  assert.equal(second.name, `${baseName}-02`);
  assert.equal(second.exportDirName, `${baseName}-02`);
  assert.equal(listLiveMixcutProjects(db).length, 2);
  const batch = getBatchProduction(db, first.id, first.batchId);
  assert.equal(batch?.projectId, first.id);
  assert.equal(batch?.name, baseName);
  assert.equal(batch?.planningMode, 'formula');

  assert.throws(() => createLiveMixcutProject(db, { ...input, storeCode: 'X店' }), /店铺/);
  assert.throws(() => createLiveMixcutProject(db, { ...input, productCode: ' ' }), /型号/);
  assert.throws(() => createLiveMixcutProject(db, { ...input, editorName: '' }), /剪辑师/);
  assert.equal(listLiveMixcutProjects(db).length, 2);

  const renamed = updateLiveMixcutProject(db, first.id, { name: '新任务名' }, new Date('2026-10-24T02:02:03.000Z'));
  assert.equal(renamed.name, '新任务名');
  assert.equal(renamed.exportDirName, first.exportDirName);
  assert.equal(renamed.batchId, first.batchId);

  const exportedFile = path.join(root, 'storage', 'live-mixcut', 'exports', first.exportDirName, '成片', 'keep.mp4');
  fs.mkdirSync(path.dirname(exportedFile), { recursive: true });
  fs.writeFileSync(exportedFile, '保留已导出文件');
  deleteLiveMixcutProject(db, first.id, new Date('2026-10-24T03:02:03.000Z'));
  assert.deepEqual(listLiveMixcutProjects(db).map(project => project.id), [second.id]);
  assert.throws(() => readLiveMixcutProject(db, first.id), /任务不存在/);
  assert.equal(getBatchProduction(db, first.id, first.batchId)?.id, first.batchId);
  assert.equal(fs.readFileSync(exportedFile, 'utf8'), '保留已导出文件');
  console.log('live mixcut projects tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
