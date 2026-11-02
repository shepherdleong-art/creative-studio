import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-schema-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { readSchemaUpgradeAudit } = await import('../lib/schema-upgrade/audit.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');

function openDatabase(root: string): Database.Database {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE existing_business_table (id TEXT PRIMARY KEY)');
  return db;
}

function options(root: string, db: Database.Database) {
  return { db, ...schemaUpgradeRuntimePaths(root), now: () => new Date('2026-11-02T08:00:00.000Z') };
}

const databases = new Set<Database.Database>();
try {
  const root = path.join(fixtureRoot, 'ready');
  const db = openDatabase(root);
  databases.add(db);

  const team = await checkTeamServiceReadiness(options(root, db));
  assert.equal(team.available, true);
  assert.deepEqual(team.appliedVersions, [1, 2, 3, 4, 5, 6]);
  const execution = await checkExecutionReadiness(options(root, db));
  assert.equal(execution.available, true);
  assert.deepEqual(execution.appliedVersions, [1, 2]);

  assert.deepEqual(
    db.prepare('SELECT id, maintenance FROM team_service_state').get(),
    { id: 1, maintenance: 0 },
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'execution_instances'").get());
  assert.deepEqual(db.prepare('SELECT version FROM team_schema_migrations').all(), [
    { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 },
  ]);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_files'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_file_references'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_resource_scopes'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_task_principals'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_font_favorites'").get());
  for (const table of [
    'team_lifecycle_events', 'team_lifecycle_event_scopes', 'team_lifecycle_barriers',
    'team_backup_pins', 'team_cleanup_jobs', 'team_cleanup_files',
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `缺少 ${table}`);
  }
  assert.equal((db.prepare("SELECT type FROM pragma_table_info('team_users') WHERE name = 'employeeId'").get() as { type: string }).type, 'TEXT');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_sessions'").get());
  assert.deepEqual(db.prepare('SELECT version FROM execution_schema_migrations').all(), [{ version: 1 }, { version: 2 }]);
  for (const table of [
    'execution_operations', 'execution_attempts', 'execution_pools',
    'execution_actor_policies', 'execution_reservations', 'execution_admission_state',
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `缺少 ${table}`);
  }

  const teamAgain = await checkTeamServiceReadiness(options(root, db));
  const executionAgain = await checkExecutionReadiness(options(root, db));
  assert.equal(teamAgain.available, true);
  assert.equal(executionAgain.available, true);
  assert.deepEqual(teamAgain.appliedVersions, [], '重复 readiness 不得重放团队迁移');
  assert.deepEqual(executionAgain.appliedVersions, [], '重复 readiness 不得重放执行迁移');
  assert.equal(
    fs.readdirSync(schemaUpgradeRuntimePaths(root).backupRoot).length,
    2,
    '幂等检查只保留首次两套迁移的备份',
  );
  const audit = await readSchemaUpgradeAudit(schemaUpgradeRuntimePaths(root).auditFilePath);
  assert.ok(audit.some((record) => record.scope === 'team-service' && record.event === 'backup_completed'));
  assert.ok(audit.some((record) => record.scope === 'execution' && record.event === 'backup_completed'));

  const noSpaceRoot = path.join(fixtureRoot, 'no-space');
  const noSpaceDb = openDatabase(noSpaceRoot);
  databases.add(noSpaceDb);
  const noSpace = await checkTeamServiceReadiness({
    ...options(noSpaceRoot, noSpaceDb),
    diskSpaceProbe: async () => 0,
  });
  assert.equal(noSpace.available, false);
  assert.equal(noSpace.code, 'insufficient_disk_space');
  assert.equal(
    noSpaceDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_service_state'").get(),
    undefined,
    '备份门禁失败不得留下半套业务结构',
  );

  const failureRoot = path.join(fixtureRoot, 'migration-failure');
  const failureDb = openDatabase(failureRoot);
  databases.add(failureDb);
  failureDb.exec('CREATE TABLE team_service_state (id INTEGER PRIMARY KEY)');
  const failed = await checkTeamServiceReadiness(options(failureRoot, failureDb));
  assert.equal(failed.available, false);
  assert.equal(failed.code, 'migration_failed');
  assert.equal(fs.readdirSync(schemaUpgradeRuntimePaths(failureRoot).backupRoot).length, 1);
  const failureAudit = await readSchemaUpgradeAudit(schemaUpgradeRuntimePaths(failureRoot).auditFilePath);
  assert.ok(failureAudit.some((record) => record.event === 'backup_completed'));
  assert.ok(failureAudit.some((record) => record.event === 'compatibility_entered'));

  const futureRoot = path.join(fixtureRoot, 'future-schema');
  const futureDb = openDatabase(futureRoot);
  databases.add(futureDb);
  futureDb.exec(`
    CREATE TABLE team_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
    INSERT INTO team_schema_migrations VALUES (999, '2026-11-02T08:00:00.000Z');
  `);
  const future = await checkTeamServiceReadiness(options(futureRoot, futureDb));
  assert.equal(future.available, false);
  assert.equal(future.code, 'schema_too_new');

  console.log('team service schema tests passed');
} finally {
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
