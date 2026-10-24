// 实拍混剪表结构生成脚本（执行清单卡 2）。
// 在临时库里跑完 Codex 分支上的批量 v1–v27 和公式 v1–v26 迁移，把最终结构导出成实拍混剪的 v1：
//   - 表名 batch_x → live_mixcut_x（batch_formula_x → live_mixcut_formula_x）
//   - 外键 REFERENCES projects(id) → REFERENCES live_mixcut_projects(id)（实拍混剪的任务表；复制来的代码处处用 projectId，正好对上）
//   - 不要：两张旧迁移记录表、ZIP 导出包的两张表
// 必须在卡 4（批量恢复成 main）之前跑：它读的是本分支上 lib/batch-production 的迁移。
// 用法：node scripts/live-mixcut-port/generate-schema.mjs [--out <目录>]
//   默认写到 lib/live-mixcut/；--out 只用于试跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const repo = process.cwd();
const outDir = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : path.join(repo, 'lib/live-mixcut');
const Database = createRequire(path.join(repo, 'package.json'))('better-sqlite3');

const EXCLUDED_TABLES = new Set([
  'batch_schema_migrations',
  'batch_formula_schema_migrations',
  'batch_formula_export_packages',
  'batch_formula_export_package_items',
]);

const PROJECTS_DDL = `CREATE TABLE live_mixcut_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  productName TEXT NOT NULL,
  exportDirName TEXT NOT NULL UNIQUE,
  batchId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
)`;

async function dumpAndCheck(transform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-mixcut-schema-'));
  process.env.CREATIVE_STUDIO_DATA_ROOT = root;
  process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
  const { checkBatchProductionReadiness } = await import(path.join(repo, 'lib/batch-production/readiness.ts'));
  const { checkFormulaReadiness } = await import(path.join(repo, 'lib/batch-production/formula/readiness.ts'));
  const { schemaUpgradeRuntimePaths } = await import(path.join(repo, 'lib/schema-upgrade/runtime.ts'));
  const db = new Database(path.join(root, 'workbench.db'));
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    const readiness = { db, ...schemaUpgradeRuntimePaths(root) };
    const batch = await checkBatchProductionReadiness(readiness);
    const formula = await checkFormulaReadiness(readiness);
    if (!batch.available || !formula.available) throw new Error(`迁移没跑完：batch=${batch.message} formula=${formula.message}`);
    const rows = db.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
      WHERE tbl_name LIKE 'batch\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY rowid`).all();
    const order = { table: 0, index: 1, view: 2, trigger: 3 };
    const statements = transform(rows.filter(row => !EXCLUDED_TABLES.has(row.tableName))
      .sort((a, b) => order[a.type] - order[b.type])
      .map(row => row.sql.trim()));
    // 用户的真实库里已经有批量的表和索引：在同一个库里再建一遍，名字有一个撞了就会在这里失败。
    db.exec(statements.join(';\n') + ';');
    if (db.pragma('foreign_key_check').length) throw new Error('和批量表同库时外键检查未通过');
    return statements;
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function transform(statements) {
  const sql = statements.map(statement => statement
    .replace(/batch_/g, 'live_mixcut_')
    .replace(/\bidx_formula_/g, 'idx_live_mixcut_formula_')
    .replace(/REFERENCES\s+"?projects"?\s*\(\s*"?id"?\s*\)/g, 'REFERENCES live_mixcut_projects(id)'));
  const leftover = sql.filter(statement => /\bprojects\b/.test(statement));
  if (leftover.length) {
    console.error('还有语句引用 projects 表，停下来报告：');
    for (const statement of leftover) console.error(statement.slice(0, 300));
    process.exit(1);
  }
  const all = [PROJECTS_DDL, ...sql];
  const badNames = all.map(statement => /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z0-9_]+)/i.exec(statement)?.[1])
    .filter(name => !name || !/^(idx_)?live_mixcut_/.test(name));
  if (badNames.length) {
    console.error('有对象名没带 live_mixcut_ 前缀，会和别的模块撞名，停下来报告：', badNames.join(', '));
    process.exit(1);
  }
  return all;
}

function verify(statements) {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(statements.join(';\n') + ';');
    if (db.pragma('foreign_key_check').length) throw new Error('外键检查未通过');
    return db.prepare(`SELECT type, COUNT(*) AS count FROM sqlite_master WHERE sql IS NOT NULL GROUP BY type`).all();
  } finally {
    db.close();
  }
}

function sqlModule(statements) {
  const body = statements.join(';\n\n') + ';\n';
  const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `// 由 scripts/live-mixcut-port/generate-schema.mjs 生成，不要手改。
// 来源：Codex 分支上批量 v1–v27 和公式 v1–v26 迁移跑完后的最终结构，改名为 live_mixcut_*。
// 这是实拍混剪迁移 v1 的内容；以后改表结构只能在 schema.ts 里追加新版本。
export const LIVE_MIXCUT_SCHEMA_V1_SQL = \`
${escaped}\`;
`;
}

const SCHEMA_MODULE = `/**
 * 实拍混剪独立迁移流。照创作画布的写法：只用自己的表，迁移只能追加，
 * 必须经过 lib/schema-upgrade/ 的共享备份、锁与审计（见 readiness.ts）。
 * 导出名沿用批量的 ensureBatchSchemaReady / BatchSchemaFailureCode，复制过来的 readiness.ts 不用改。
 */
import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';
import { LIVE_MIXCUT_SCHEMA_V1_SQL } from './schema-v1-sql.ts';

export interface LiveMixcutMigration {
  version: number;
  sql: string;
}

export const LIVE_MIXCUT_MIGRATIONS: ReadonlyArray<LiveMixcutMigration> = [
  { version: 1, sql: LIVE_MIXCUT_SCHEMA_V1_SQL },
];

export type BatchSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type BatchSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: BatchSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: SchemaUpgradeBackupManifest;
    };

export interface EnsureLiveMixcutSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}

const MIGRATION_TABLE = 'live_mixcut_schema_migrations';
const CORE_TABLES = ['live_mixcut_projects', 'live_mixcut_productions', 'live_mixcut_output_plans', 'live_mixcut_formula_generation_requests'];

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function readLiveMixcutAppliedVersions(db: Database.Database): number[] {
  if (!tableExists(db, MIGRATION_TABLE)) return [];
  return (db.prepare(\`SELECT version FROM \${MIGRATION_TABLE} ORDER BY version\`).all() as Array<{ version: number }>)
    .map(({ version }) => version);
}

/** 是否已经存在实拍混剪的表；开关关闭时不得产生这些表。 */
export function liveMixcutTablesPresent(db: Database.Database): boolean {
  return CORE_TABLES.some(table => tableExists(db, table));
}

function validateMigrationHistory(applied: number[]): BatchSchemaFailureCode | null {
  const known = LIVE_MIXCUT_MIGRATIONS.map(({ version }) => version);
  if (applied.some(version => version > (known.at(-1) ?? 0))) return 'schema_too_new';
  if (applied.some(version => !known.includes(version))) return 'schema_history_invalid';
  const highest = applied.at(-1) ?? 0;
  if (known.some(version => version <= highest && !applied.includes(version))) return 'schema_history_invalid';
  return null;
}

function applyMigration(db: Database.Database, migration: LiveMixcutMigration, appliedAt: string): void {
  const apply = db.transaction(() => {
    db.exec(\`CREATE TABLE IF NOT EXISTS \${MIGRATION_TABLE} (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)\`);
    db.exec(migration.sql);
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('实拍混剪迁移后的外键检查未通过');
    db.prepare(\`INSERT INTO \${MIGRATION_TABLE} (version, appliedAt) VALUES (?, ?)\`).run(migration.version, appliedAt);
  });
  apply.immediate();
}

function unavailable(code: BatchSchemaFailureCode, message: string, targetVersion: number,
  extra: Partial<Pick<Extract<BatchSchemaReadiness, { state: 'compatibility_only' }>, 'appliedVersions' | 'backupDirectory' | 'backupManifest'>> = {}): BatchSchemaReadiness {
  return { state: 'compatibility_only', code, message, appliedVersions: [], targetVersion, ...extra };
}

export async function ensureBatchSchemaReady(options: EnsureLiveMixcutSchemaOptions): Promise<BatchSchemaReadiness> {
  const { db, backupRoot, now = () => new Date(), diskSpaceProbe } = options;
  const targetVersion = LIVE_MIXCUT_MIGRATIONS.at(-1)?.version ?? 0;
  let applied: number[];
  try {
    applied = readLiveMixcutAppliedVersions(db);
  } catch {
    return unavailable('schema_history_invalid', '实拍混剪的升级记录无法读取，其他功能不受影响。', targetVersion);
  }
  const historyFailure = validateMigrationHistory(applied);
  if (historyFailure) {
    return unavailable(historyFailure, historyFailure === 'schema_too_new'
      ? '当前数据库来自更新版本，实拍混剪暂不可用。' : '实拍混剪的升级记录不完整，其他功能不受影响。', targetVersion);
  }
  if (applied.length > 0 && !CORE_TABLES.every(table => tableExists(db, table))) {
    return unavailable('schema_history_invalid', '实拍混剪的数据结构与升级记录不一致，其他功能不受影响。', targetVersion);
  }
  const pending = LIVE_MIXCUT_MIGRATIONS.filter(({ version }) => !applied.includes(version));
  if (pending.length === 0) return { state: 'current', appliedVersions: applied, targetVersion };

  let backupDirectory: string | undefined;
  let backupManifest: SchemaUpgradeBackupManifest | undefined;
  try {
    const backup = await createValidatedSchemaUpgradeBackup({
      db, backupRoot, scope: 'live-mixcut', sourceVersions: applied, targetVersion, now: now(), diskSpaceProbe,
    });
    backupDirectory = backup.directory;
    backupManifest = backup.manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法完成实拍混剪数据库安全备份。';
    return unavailable(message.includes('空间不足') ? 'insufficient_disk_space'
      : message.includes('完整性') ? 'backup_validation_failed' : 'backup_failed', message, targetVersion);
  }
  const newlyApplied: number[] = [];
  try {
    for (const migration of pending) {
      applyMigration(db, migration, now().toISOString());
      newlyApplied.push(migration.version);
    }
  } catch {
    return unavailable('migration_failed', '实拍混剪数据库升级未完成，其他功能不受影响。', targetVersion,
      { appliedVersions: newlyApplied, backupDirectory, backupManifest });
  }
  return { state: 'ready', appliedVersions: newlyApplied, targetVersion, backupDirectory, backupManifest };
}
`;

const statements = await dumpAndCheck(transform);
const counts = verify(statements);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'schema-v1-sql.ts'), sqlModule(statements), 'utf8');
fs.writeFileSync(path.join(outDir, 'schema.ts'), SCHEMA_MODULE, 'utf8');
console.log(`写入 ${path.join(outDir, 'schema-v1-sql.ts')} 和 schema.ts`);
console.log(counts.map(({ type, count }) => `${type} ${count}`).join('，'));
