import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkCanvasReadiness } from '../lib/creative-canvas/readiness.ts';
import { createBatchProduction, getBatchProduction } from '../lib/batch-production/versions.ts';
import { listSchemaUpgradeRecoveryCandidates } from '../lib/schema-upgrade/recovery.ts';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-backup-test-'));
const originalRename = fsPromises.rename;
try {
  const caseRoot = path.join(root, 'temporary-rename-denial');
  fs.mkdirSync(caseRoot);
  const db = new Database(path.join(caseRoot, 'workbench.db'));
  try {
    db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','原有项目');");
    const options = { db, ...schemaUpgradeRuntimePaths(caseRoot) };
    const base = await checkBatchProductionReadiness(options);
    assert.equal(base.available, true, JSON.stringify(base));
    const batchId = createBatchProduction(db, 'p', '升级前的普通批次');
    let attempts = 0;
    const renamePairs: Array<[string, string]> = [];
    // 模拟在 Windows 实际捕获到的文件系统边界错误；备份、校验、迁移与审计均真实执行。
    fsPromises.rename = async (from, to) => {
      if (String(from).includes(`${path.sep}.pre-canvas-`)) {
        attempts++;
        renamePairs.push([String(from), String(to)]);
        if (process.platform === 'win32' && attempts === 1) {
          throw Object.assign(new Error('temporarily locked backup directory'), { code: 'EPERM', syscall: 'rename' });
        }
      }
      return originalRename(from, to);
    };
    const ready = await checkCanvasReadiness(options);
    assert.equal(ready.available, true, `短暂重命名失败后应完成同一次升级：${JSON.stringify(ready)}`);
    assert.equal(getBatchProduction(db, 'p', batchId)?.name, '升级前的普通批次');
    assert.equal(new Set(renamePairs.map(pair => JSON.stringify(pair))).size, 1, '只重试同一份已校验备份，不重新创建备份');
    if (process.platform === 'win32') assert(attempts >= 2 && attempts <= 5);
    else assert.equal(attempts, 1);
    const candidates = await listSchemaUpgradeRecoveryCandidates({ backupRoot: options.backupRoot, scope: 'creative-canvas' });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].verification, 'verified');
    const backupDirectory = path.join(options.backupRoot, candidates[0].backupId);
    const bytes = fs.readFileSync(path.join(backupDirectory, 'workbench.db'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), candidates[0].databaseSha256);
    const restored = new Database(path.join(backupDirectory, 'workbench.db'), { readonly: true });
    try {
      assert.equal(getBatchProduction(restored, 'p', batchId)?.name, '升级前的普通批次');
      assert.equal(restored.prepare("SELECT 1 FROM sqlite_master WHERE name='creative_canvas_schema_migrations'").get(), undefined,
        '备份必须仍是迁移前数据');
    } finally { restored.close(); }
    assert.equal(fs.readdirSync(options.backupRoot).some(name => name.startsWith('.pre-')), false);
    const audit = fs.readFileSync(options.auditFilePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit.filter(row => row.scope === 'creative-canvas' && row.event === 'backup_completed').length, 1);
    assert.equal(audit.filter(row => row.scope === 'creative-canvas' && row.event === 'migration_completed').length, 1);
  } finally { fsPromises.rename = originalRename; db.close(); }

  for (const scenario of [
    { code: 'EPERM', temporary: false },
    { code: 'ENOSPC', temporary: false },
    ...(process.platform === 'win32' ? [{ code: 'EACCES', temporary: true }, { code: 'EBUSY', temporary: true }] : []),
  ]) {
    const failureRoot = path.join(root, `${scenario.code}-${scenario.temporary}`);
    fs.mkdirSync(failureRoot);
    const failureDb = new Database(path.join(failureRoot, 'workbench.db'));
    try {
      failureDb.pragma('foreign_keys=ON');
      failureDb.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO projects VALUES ('p','保留项目');");
      const options = { db: failureDb, ...schemaUpgradeRuntimePaths(failureRoot) };
      const base = await checkBatchProductionReadiness(options);
      assert.equal(base.available, true, JSON.stringify(base));
      const existing = createBatchProduction(failureDb, 'p', '普通批次应保留');
      let attempts = 0;
      fsPromises.rename = async (from, to) => {
        if (String(from).includes(`${path.sep}.pre-canvas-`)) {
          attempts++;
          if (!scenario.temporary || attempts === 1) {
            throw Object.assign(new Error('filesystem boundary denial'), { code: scenario.code, syscall: 'rename' });
          }
        }
        return originalRename(from, to);
      };
      const result = await checkCanvasReadiness(options);
      assert.equal(result.available, scenario.temporary, JSON.stringify(result));
      assert.equal(getBatchProduction(failureDb, 'p', existing)?.name, '普通批次应保留');
      assert.equal(fs.readdirSync(options.backupRoot).some(name => name.startsWith('.pre-')), false, '失败暂存不残留');
      if (scenario.temporary) {
        assert(attempts >= 2 && attempts <= 5);
      } else {
        if (result.available) throw new Error('持续备份故障不应报告就绪');
        assert.equal(result.code, 'backup_failed');
        assert(attempts >= 1 && attempts <= 5, '持续错误必须有界结束');
        if (scenario.code === 'ENOSPC' || process.platform !== 'win32') assert.equal(attempts, 1, '非短暂占用错误不重试');
        assert.equal(failureDb.prepare("SELECT 1 FROM sqlite_master WHERE name='creative_canvas_schema_migrations'").get(), undefined,
          '备份未发布时不能启动画布迁移');
        assert.deepEqual(await listSchemaUpgradeRecoveryCandidates({ backupRoot: options.backupRoot, scope: 'creative-canvas' }), []);
        const ordinary = await checkBatchProductionReadiness(options);
        assert.equal(ordinary.available, true, JSON.stringify(ordinary));
        assert.equal(getBatchProduction(failureDb, 'p', createBatchProduction(failureDb, 'p', '仍可新建普通批次'))?.name, '仍可新建普通批次');
        const audit = fs.readFileSync(options.auditFilePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(audit.filter(row => row.scope === 'creative-canvas' && row.event === 'backup_completed').length, 0);
        assert.equal(audit.filter(row => row.scope === 'creative-canvas' && row.event === 'migration_completed').length, 0);
      }
    } finally { fsPromises.rename = originalRename; failureDb.close(); }
  }
  console.log('schema upgrade backup tests passed');
} finally {
  fsPromises.rename = originalRename;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
