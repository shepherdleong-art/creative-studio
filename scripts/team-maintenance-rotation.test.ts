import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-rotation-'));
const dataRoot = path.join(fixtureRoot, 'root');
const storageRoot = path.join(dataRoot, 'storage');
const backupRoot = path.join(fixtureRoot, 'backups');
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'media'), { recursive: true });
fs.writeFileSync(path.join(storageRoot, 'media', 'shared.bin'), 'shared-production-object');
const configPath = path.join(fixtureRoot, 'config.json');
fs.writeFileSync(configPath, '{"fixture":true}');
const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE team_users (id TEXT PRIMARY KEY, role TEXT NOT NULL);
  CREATE TABLE team_resource_scopes (
    resourceType TEXT, resourceId TEXT, ownerUserId TEXT, visibility TEXT DEFAULT 'private',
    parentType TEXT, parentId TEXT, rootType TEXT, rootId TEXT, deletedAt TEXT, deletedBy TEXT,
    createdAt TEXT, updatedAt TEXT, PRIMARY KEY(resourceType, resourceId),
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_files (
    id TEXT PRIMARY KEY, seriesId TEXT, version INTEGER, ownerUserId TEXT, relativePath TEXT UNIQUE,
    mimeType TEXT, byteSize INTEGER, sha256 TEXT, state TEXT, derivedFromFileId TEXT,
    readySeq INTEGER UNIQUE, createdAt TEXT, readyAt TEXT, FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_file_references (
    fileId TEXT, resourceType TEXT, resourceId TEXT, role TEXT, pinKind TEXT, createdAt TEXT, releasedAt TEXT,
    FOREIGN KEY(fileId) REFERENCES team_files(id),
    FOREIGN KEY(resourceType, resourceId) REFERENCES team_resource_scopes(resourceType, resourceId)
  );
  CREATE UNIQUE INDEX idx_team_file_reference_active
    ON team_file_references(fileId, resourceType, resourceId, role, pinKind) WHERE releasedAt IS NULL;
  CREATE TABLE team_lifecycle_barriers (
    id TEXT PRIMARY KEY, kind TEXT, ownerUserId TEXT, metadataJson TEXT, createdAt TEXT, releasedAt TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_backup_pins (
    id TEXT PRIMARY KEY, ownerUserId TEXT, releaseId TEXT, configVersion TEXT, createdAt TEXT, releasedAt TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_cleanup_jobs (
    id TEXT PRIMARY KEY, resourceType TEXT, resourceId TEXT, requestedBy TEXT, status TEXT, phase TEXT,
    blockersJson TEXT DEFAULT '[]', error TEXT, createdAt TEXT, updatedAt TEXT,
    FOREIGN KEY(requestedBy) REFERENCES team_users(id)
  );
  CREATE TABLE team_cleanup_files (
    jobId TEXT, fileId TEXT, relativePath TEXT, status TEXT, error TEXT, updatedAt TEXT,
    PRIMARY KEY(jobId, fileId), FOREIGN KEY(jobId) REFERENCES team_cleanup_jobs(id),
    FOREIGN KEY(fileId) REFERENCES team_files(id)
  );
  INSERT INTO team_users VALUES ('admin', 'admin');
`);
const { createTeamBackup, rotateDailyTeamBackups } = await import('../lib/team-service/maintenance/backup.ts');
const { registerReadyTeamFile } = await import('../lib/team-service/files/registry.ts');
const admin = { userId: 'admin', role: 'admin' as const };
const at = new Date().toISOString();
db.prepare(`INSERT INTO team_resource_scopes (
  resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt
) VALUES ('project', 'project-1', 'admin', 'project', 'project-1', ?, ?)`).run(at, at);
registerReadyTeamFile(db, {
  storageRoot, absolutePath: path.join(storageRoot, 'media', 'shared.bin'),
  mimeType: 'application/octet-stream', ownerUserId: 'admin',
  references: [{ resourceType: 'project', resourceId: 'project-1' }],
});
const release = { releaseId: 'release-1', packageSha256: 'b'.repeat(64) };
let sequence = 0;
function input(type: 'daily' | 'manual' | 'pre-upgrade', backupId: string) {
  sequence += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence));
  return {
    db, principal: admin, dataRoot, storageRoot, backupRoot, deploymentId: 'deployment-rotation', type,
    release, config: { version: 'config-1', filePath: configPath }, backupId, now: () => at,
  };
}
function publishedIds(type: string): string[] {
  const root = path.join(backupRoot, type);
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => !name.startsWith('.')).sort() : [];
}

try {
  for (let index = 1; index <= 15; index += 1) {
    const backupId = `daily-${String(index).padStart(2, '0')}`;
    const result = await createTeamBackup(input('daily', backupId));
    if (index === 15) assert.deepEqual(result.rotation?.deletedBackupIds, ['daily-01']);
  }
  assert.equal(publishedIds('daily').length, 14);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-01')), false);
  assert.equal(fs.readFileSync(path.join(storageRoot, 'media', 'shared.bin'), 'utf8'), 'shared-production-object');
  assert.equal(fs.readFileSync(path.join(backupRoot, 'daily', 'daily-15', 'files', 'media', 'shared.bin'), 'utf8'), 'shared-production-object');

  await createTeamBackup(input('manual', 'manual-keep'));
  await createTeamBackup(input('pre-upgrade', 'pre-upgrade-keep'));
  await assert.rejects(() => createTeamBackup({
    ...input('daily', 'daily-16'), diskSpaceProbe: async () => 0,
  }), /空间不足/);
  assert.equal(publishedIds('daily').length, 14);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-02')), true);

  const deletionFailure = await createTeamBackup({
    ...input('daily', 'daily-16'),
    removeDirectory: async () => { throw new Error('injected delete failure'); },
  });
  assert.equal(deletionFailure.rotation?.errors[0]?.code, 'cleanup_failed');
  assert.equal(publishedIds('daily').length, 15);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-02')), true);

  const retry = await rotateDailyTeamBackups({ backupRoot, db, principal: admin });
  assert.deepEqual(retry.deletedBackupIds, ['daily-02']);
  assert.equal(publishedIds('daily').length, 14);
  assert.deepEqual(publishedIds('manual'), ['manual-keep']);
  assert.deepEqual(publishedIds('pre-upgrade'), ['pre-upgrade-keep']);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-16', 'success.json')), true);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'data', 'backups')), false, 'schema-upgrade 区域不属于 daily 轮换');
  const receipt = fs.readFileSync(path.join(backupRoot, 'maintenance-receipts', 'deployment-rotation.jsonl'), 'utf8');
  assert.match(receipt, /"phase":"failed"/);
  assert.match(receipt, /"backupId":"daily-16"/);
  assert.doesNotMatch(receipt, /fixtureSecret|apiKey|token/i);

  const crashStaging = path.join(backupRoot, 'daily', '.daily-crash.staging');
  fs.mkdirSync(crashStaging);
  await assert.rejects(() => createTeamBackup(input('daily', 'daily-crash')), /owner/);
  assert.equal(fs.existsSync(crashStaging), true, '未知 staging 不得被清理');
  fs.writeFileSync(path.join(crashStaging, 'maintenance-staging.json'), JSON.stringify({
    schemaVersion: 1, backupId: 'daily-crash', deploymentId: 'deployment-rotation', type: 'daily',
  }));
  const recoveredStaging = await createTeamBackup(input('daily', 'daily-crash'));
  assert.equal(recoveredStaging.success.status, 'success');
  assert.equal(fs.existsSync(crashStaging), false);

  console.log('team maintenance daily rotation tests passed');
} finally {
  db.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
