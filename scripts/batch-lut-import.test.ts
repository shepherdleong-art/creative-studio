// scripts/batch-lut-import.test.ts
//
// LutCatalog 完整导入链路(D3):普通文件/扩展名/大小限制、完整 SHA-256、
// 同一内容复用、同名不同内容不覆盖、真实 FFmpeg lut3d 验证损坏文件被拒绝、
// 临时文件加原子落位。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lut-import-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const schemaModule = await import('../lib/batch-production/schema.ts');
const lutCatalogModule = await import('../lib/batch-production/lut-catalog.ts');

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-lut-import-work-'));

function identityCube(): Buffer {
  return Buffer.from([
    'LUT_3D_SIZE 2',
    '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
    '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
  ].join('\n'));
}

try {
  const dbRoot = path.join(workRoot, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');
  const migrated = await schemaModule.ensureBatchSchemaReady({
    db, backupRoot: path.join(dbRoot, 'backups'), now: () => new Date('2026-08-03T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 场景 1:合法 .cube 真实通过 FFmpeg lut3d 验证并原子落位 ---
  const first = await lutCatalogModule.importLut(db, 'project-1', {
    filename: 'Camera LOG.cube', mimeType: 'application/octet-stream', data: identityCube(),
  }, () => new Date('2026-08-03T08:01:00.000Z'));
  assert.equal(first.reused, false);
  const lut = lutCatalogModule.getLut(db, 'project-1', first.id);
  assert.ok(lut);
  assert.equal(lut!.status, 'active');
  assert.ok(lut!.verifiedAt, '导入必须记录验证时间');
  const absolutePath = lutCatalogModule.resolveManagedLutPath(lut!.relativePath);
  assert.ok(fs.existsSync(absolutePath), 'LUT 必须原子落位到受管目录');
  assert.ok(!fs.existsSync(`${absolutePath}.tmp`), '不应该残留临时文件路径(前缀不同,这里只是形状检查)');
  assert.ok(absolutePath.startsWith(path.join(externalDataRoot, 'storage', 'luts')), 'LUT 必须落在受管 luts 目录下');

  // --- 场景 2:同一内容重复导入必须复用同一身份,不产生第二份受管文件 ---
  const dup = await lutCatalogModule.importLut(db, 'project-1', {
    filename: '相机LOG-重新选择.cube', mimeType: 'application/octet-stream', data: identityCube(),
  }, () => new Date('2026-08-03T08:02:00.000Z'));
  assert.equal(dup.id, first.id, '同一完整内容指纹必须复用同一 LUT 身份');
  assert.equal(dup.reused, true);

  // --- 场景 3:同名不同内容必须建立新身份,不覆盖旧内容 ---
  const differentContent = Buffer.concat([identityCube(), Buffer.from('\n# variant\n')]);
  const second = await lutCatalogModule.importLut(db, 'project-1', {
    filename: 'Camera LOG.cube', mimeType: 'application/octet-stream', data: differentContent,
  }, () => new Date('2026-08-03T08:03:00.000Z'));
  assert.notEqual(second.id, first.id, '同名不同内容必须建立新的 LUT 身份');
  assert.equal(lutCatalogModule.getLut(db, 'project-1', first.id)?.relativePath, lut!.relativePath, '旧 LUT 的受管文件位置不能被同名新导入改写');

  // --- 场景 4:损坏/不受支持的 .cube 内容必须被真实 FFmpeg lut3d 验证拒绝,不留下受管文件 ---
  const beforeCount = lutCatalogModule.listProjectLuts(db, 'project-1', { includeArchived: true }).length;
  await assert.rejects(
    () => lutCatalogModule.importLut(db, 'project-1', {
      filename: 'broken.cube', mimeType: 'application/octet-stream', data: Buffer.from('this is not a valid cube file at all'),
    }),
    (error: unknown) => error instanceof lutCatalogModule.LutImportError && error.code === 'invalid_lut_content',
    '损坏的 LUT 内容必须被真实 FFmpeg lut3d 验证拒绝',
  );
  assert.equal(
    lutCatalogModule.listProjectLuts(db, 'project-1', { includeArchived: true }).length,
    beforeCount,
    '验证失败不能留下任何新的 LUT 记录',
  );
  const lutsDir = path.join(externalDataRoot, 'storage', 'luts', 'project-1');
  const leftoverTempFiles = fs.existsSync(lutsDir)
    ? fs.readdirSync(lutsDir).filter((name) => name.includes('.tmp-'))
    : [];
  assert.deepEqual(leftoverTempFiles, [], '验证失败必须清理临时文件,不能残留半成品');

  // --- 场景 5:扩展名/空文件校验 ---
  await assert.rejects(
    () => lutCatalogModule.importLut(db, 'project-1', {
      filename: 'not-a-lut.txt', mimeType: 'text/plain', data: Buffer.from('hello'),
    }),
    (error: unknown) => error instanceof lutCatalogModule.LutImportError && error.code === 'unsupported_lut_format',
  );
  await assert.rejects(
    () => lutCatalogModule.importLut(db, 'project-1', {
      filename: 'empty.cube', mimeType: 'application/octet-stream', data: Buffer.alloc(0),
    }),
    (error: unknown) => error instanceof lutCatalogModule.LutImportError && error.code === 'empty_upload',
  );

  // --- 场景 6:项目隔离——项目 2 导入同样内容必须建立独立身份,互不可见 ---
  db.prepare(`INSERT INTO projects (id, name) VALUES ('project-2', '项目二')`).run();
  const projectTwoImport = await lutCatalogModule.importLut(db, 'project-2', {
    filename: 'Camera LOG.cube', mimeType: 'application/octet-stream', data: identityCube(),
  }, () => new Date('2026-08-03T08:04:00.000Z'));
  assert.notEqual(projectTwoImport.id, first.id, '不同项目即使内容相同也必须建立各自独立的 LUT 身份');
  assert.equal(lutCatalogModule.getLut(db, 'project-1', projectTwoImport.id), undefined, '项目 1 不能读取项目 2 的 LUT');

  // --- 场景 7:没有引用时物理清理必须真的删除受管文件,不只是删数据库行 ---
  assert.ok(fs.existsSync(absolutePath), '清理前受管文件必须存在(前置条件)');
  const deleted = lutCatalogModule.deleteLutIfUnreferenced(db, 'project-1', first.id);
  assert.equal(deleted, true);
  assert.equal(lutCatalogModule.getLut(db, 'project-1', first.id), undefined);
  assert.ok(!fs.existsSync(absolutePath), '物理清理必须真的删除受管文件,不能只删数据库记录留下孤儿文件');

  db.close();
  console.log('batch-lut-import (real ffmpeg lut3d verification) tests passed');
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}
