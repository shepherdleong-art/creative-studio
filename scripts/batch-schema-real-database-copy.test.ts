import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { checkVideoProviderGatewayReadiness } from '../lib/video-provider-schema-readiness.ts';

interface TableFingerprint {
  rowCount: number;
  sha256: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function fingerprintLegacyTables(db: Database.Database): Map<string, TableFingerprint> {
  const tableNames = (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  return new Map(tableNames.map((tableName) => {
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
    const canonicalRows = rows.map((row) => JSON.stringify(row)).sort();
    return [tableName, {
      rowCount: rows.length,
      sha256: createHash('sha256').update(canonicalRows.join('\n')).digest('hex'),
    }];
  }));
}

const configuredSource = process.env.CREATIVE_STUDIO_LEGACY_DB_COPY_SOURCE;
const sourcePath = path.resolve(configuredSource || path.join(process.cwd(), 'data', 'workbench.db'));

if (!fs.existsSync(sourcePath)) {
  console.log('real database copy test skipped: source database not found');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-real-db-copy-'));
const copiedDatabasePath = path.join(root, 'workbench.db');

try {
  const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(copiedDatabasePath);
  } finally {
    sourceDb.close();
  }

  const copiedDb = new Database(copiedDatabasePath);
  copiedDb.pragma('foreign_keys = ON');
  const before = fingerprintLegacyTables(copiedDb);

  const commonPaths = {
    backupRoot: path.join(root, 'backups'),
    lockDatabasePath: path.join(root, 'schema-upgrade.lock.db'),
    auditFilePath: path.join(root, 'schema-upgrades.jsonl'),
  };
  const gateway = await checkVideoProviderGatewayReadiness({ db: copiedDb, ...commonPaths });
  assert.equal(gateway.available, true, '真实旧库副本必须安全通过视频供应商结构门禁');
  const batch = await checkBatchProductionReadiness({ db: copiedDb, ...commonPaths });
  assert.equal(batch.available, true, '真实旧库副本必须安全通过批量结构门禁');

  const after = fingerprintLegacyTables(copiedDb);
  // batch_luts: v15 迁移的受管内容指纹归一化目标(裸 hex → sha256:hex),
  // 行数必须不变,内容指纹必须带上 sha256: 前缀——这一处有意变化。
  // batch_schema_migrations: 升级版本记账表,追加迁移记录是预期行为。
  // batch_scripts / batch_script_snapshots / batch_productions:
  // v19/v20 追加 targetDurationSec / narrationConfigJson / archivedAt 列,
  // 既有行被补默认值,SELECT * 内容随之变化——这一处有意变化。
  const columnGrowthTables = new Set([
    'batch_scripts',
    'batch_script_snapshots',
    'batch_productions',
  ]);
  for (const [tableName, expected] of before) {
    if (tableName === 'batch_luts') {
      assert.equal(after.get(tableName)?.rowCount, expected.rowCount, 'batch_luts 行数在迁移中不得变化');
      continue;
    }
    if (tableName === 'batch_schema_migrations') {
      continue;
    }
    if (columnGrowthTables.has(tableName)) {
      assert.equal(after.get(tableName)?.rowCount, expected.rowCount, `${tableName} 行数在迁移中不得变化`);
      continue;
    }
    assert.deepEqual(
      after.get(tableName),
      expected,
      `${tableName} 的旧数据在副本升级演练中发生变化`,
    );
  }
  const lutRows = copiedDb.prepare(`SELECT id, contentFingerprint FROM batch_luts ORDER BY id`).all() as Array<{ id: string; contentFingerprint: string }>;
  for (const lut of lutRows) {
    assert.ok(
      lut.contentFingerprint.startsWith('sha256:'),
      `v15 必须把 LUT 指纹归一化为 sha256: 前缀(id=${lut.id}, 实际=${lut.contentFingerprint})`,
    );
  }
  assert.deepEqual(copiedDb.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(copiedDb.pragma('foreign_key_check'), []);
  copiedDb.close();

  const totalRows = [...before.values()].reduce((sum, table) => sum + table.rowCount, 0);
  console.log(`real database copy test passed: ${before.size} legacy tables, ${totalRows} rows preserved`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
