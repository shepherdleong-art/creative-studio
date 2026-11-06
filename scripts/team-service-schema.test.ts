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
const { EXECUTION_MIGRATIONS } = await import('../lib/media-core/execution/schema.ts');
const executionVersions = EXECUTION_MIGRATIONS.map(migration => migration.version);

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
  assert.deepEqual(team.appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const execution = await checkExecutionReadiness(options(root, db));
  assert.equal(execution.available, true);
  assert.deepEqual(execution.appliedVersions, executionVersions);

  assert.deepEqual(
    db.prepare('SELECT id, maintenance FROM team_service_state').get(),
    { id: 1, maintenance: 0 },
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'execution_instances'").get());
  assert.deepEqual(db.prepare('SELECT version FROM team_schema_migrations').all(), [
    { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 },
  ]);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_files'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_file_references'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_resource_scopes'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_task_principals'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_font_favorites'").get());
  for (const table of [
    'team_lifecycle_events', 'team_lifecycle_event_scopes', 'team_lifecycle_barriers',
    'team_backup_pins', 'team_cleanup_jobs', 'team_cleanup_files',
    'team_uploads', 'team_upload_parts', 'team_devices', 'team_download_receipts',
  ]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `缺少 ${table}`);
  }
  assert.equal((db.prepare("SELECT type FROM pragma_table_info('team_users') WHERE name = 'employeeId'").get() as { type: string }).type, 'TEXT');
  assert.equal((db.prepare("SELECT type FROM pragma_table_info('team_uploads') WHERE name = 'targetKind'").get() as { type: string }).type, 'TEXT');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_sessions'").get());
  assert.deepEqual(db.prepare('SELECT version FROM execution_schema_migrations').all(), executionVersions.map(version => ({ version })));
  for (const table of [
    'execution_operations', 'execution_attempts', 'execution_pools',
    'execution_actor_policies', 'execution_reservations', 'execution_admission_state',
    'execution_pool_bindings', 'execution_team_concurrency_policy', 'execution_actor_concurrency_migration_audit',
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

  const legacyRoot = path.join(fixtureRoot, 'legacy-errors');
  const legacyDb = openDatabase(legacyRoot);
  databases.add(legacyDb);
  const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
  legacyDb.exec('CREATE TABLE team_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
  for (const migration of TEAM_SERVICE_MIGRATIONS.filter((item) => item.version < 14)) {
    legacyDb.exec(migration.sql);
    legacyDb.prepare('INSERT INTO team_schema_migrations (version, appliedAt) VALUES (?, ?)').run(migration.version, '2026-11-02T08:00:00.000Z');
  }
  legacyDb.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('legacy-user', '0001', '旧成员', 'employee', 'active', 'not-used', '2026-11-02T08:00:00.000Z', '2026-11-02T08:00:00.000Z')`).run();
  legacyDb.prepare(`INSERT INTO team_error_records (id, actorUserId, module, stage, code, safeMessage, clientEventId, createdAt)
    VALUES ('legacy-error', 'legacy-user', 'client', 'upload', 'legacy_failed', '旧错误', 'legacy-event', '2026-11-02T08:00:00.000Z')`).run();
  const upgraded = await checkTeamServiceReadiness(options(legacyRoot, legacyDb));
  assert.equal(upgraded.available, true);
  assert.deepEqual(upgraded.appliedVersions, [14, 15]);
  assert.deepEqual(legacyDb.prepare('SELECT id, code, clientEventId, origin, outcome FROM team_error_records WHERE id = ?').get('legacy-error'), {
    id: 'legacy-error', code: 'legacy_failed', clientEventId: 'legacy-event', origin: 'client', outcome: 'final',
  }, 'v13 既有错误必须经 v14/v15 保留并安全映射');
  const { listTeamErrors, reportClientError } = await import('../lib/team-service/diagnostics.ts');
  assert.equal(listTeamErrors(legacyDb, { userId: 'legacy-user', role: 'employee' }).items[0]?.origin, 'client', '旧客户端阶段在出口正确投影');
  const legacyRepeat = reportClientError(legacyDb, { userId: 'legacy-user', role: 'employee' }, {
    clientEventId: 'legacy-event', stage: 'upload', code: 'legacy_failed',
  }, {});
  assert.equal(legacyRepeat.errorId, 'legacy-error', '旧客户端事件升级后仍须幂等');

  console.log('team service schema tests passed');
} finally {
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
