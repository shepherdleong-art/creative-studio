import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-backup-'));
const dataRoot = path.join(fixtureRoot, 'data-root');
const storageRoot = path.join(dataRoot, 'storage');
const backupRoot = path.join(fixtureRoot, 'backups');
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
fs.mkdirSync(storageRoot, { recursive: true });
const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE team_users (id TEXT PRIMARY KEY, role TEXT NOT NULL);
  CREATE TABLE team_resource_scopes (
    resourceType TEXT NOT NULL, resourceId TEXT NOT NULL, ownerUserId TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private', parentType TEXT, parentId TEXT,
    rootType TEXT NOT NULL, rootId TEXT NOT NULL, deletedAt TEXT, deletedBy TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    PRIMARY KEY(resourceType, resourceId),
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_files (
    id TEXT PRIMARY KEY, seriesId TEXT NOT NULL, version INTEGER NOT NULL,
    ownerUserId TEXT NOT NULL, relativePath TEXT NOT NULL UNIQUE, mimeType TEXT NOT NULL,
    byteSize INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL,
    derivedFromFileId TEXT, readySeq INTEGER UNIQUE, createdAt TEXT NOT NULL, readyAt TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id), UNIQUE(seriesId, version)
  );
  CREATE TABLE team_file_references (
    fileId TEXT NOT NULL, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL,
    role TEXT NOT NULL, pinKind TEXT NOT NULL, createdAt TEXT NOT NULL, releasedAt TEXT,
    FOREIGN KEY(fileId) REFERENCES team_files(id),
    FOREIGN KEY(resourceType, resourceId) REFERENCES team_resource_scopes(resourceType, resourceId)
  );
  CREATE UNIQUE INDEX idx_team_file_reference_active
    ON team_file_references(fileId, resourceType, resourceId, role, pinKind) WHERE releasedAt IS NULL;
  CREATE TABLE team_lifecycle_barriers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, ownerUserId TEXT NOT NULL,
    metadataJson TEXT NOT NULL, createdAt TEXT NOT NULL, releasedAt TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_backup_pins (
    id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, releaseId TEXT NOT NULL,
    configVersion TEXT NOT NULL, createdAt TEXT NOT NULL, releasedAt TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
  );
  CREATE TABLE team_cleanup_jobs (
    id TEXT PRIMARY KEY, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL,
    requestedBy TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
    blockersJson TEXT NOT NULL DEFAULT '[]', error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    FOREIGN KEY(requestedBy) REFERENCES team_users(id)
  );
  CREATE TABLE team_cleanup_files (
    jobId TEXT NOT NULL, fileId TEXT NOT NULL, relativePath TEXT NOT NULL,
    status TEXT NOT NULL, error TEXT, updatedAt TEXT NOT NULL,
    PRIMARY KEY(jobId, fileId), FOREIGN KEY(jobId) REFERENCES team_cleanup_jobs(id),
    FOREIGN KEY(fileId) REFERENCES team_files(id)
  );
  INSERT INTO team_users VALUES ('admin', 'admin');
`);
const at = new Date().toISOString();
db.prepare(`INSERT INTO team_resource_scopes (
  resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt
) VALUES ('project', 'project-1', 'admin', 'project', 'project-1', ?, ?)`).run(at, at);

const { registerReadyTeamFile, teamFileResponse } = await import('../lib/team-service/files/index.ts');
const { acquireLifecycleBarrier, releaseLifecycleBarrier } = await import('../lib/team-service/lifecycle/index.ts');
const { createTeamBackup, verifyTeamBackup } = await import('../lib/team-service/maintenance/backup.ts');
const admin = { userId: 'admin', role: 'admin' as const };

function media(name: string, contents: string): string {
  const file = path.join(storageRoot, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

try {
  const sourceA = media('media/a.bin', 'immutable-A');
  const fileA = registerReadyTeamFile(db, {
    storageRoot, absolutePath: sourceA, mimeType: 'application/octet-stream', ownerUserId: 'admin',
    references: [{ resourceType: 'project', resourceId: 'project-1' }],
  });

  db.prepare(`INSERT INTO team_cleanup_jobs (
    id, resourceType, resourceId, requestedBy, status, phase, createdAt, updatedAt
  ) VALUES ('cleanup-running', 'project', 'project-1', 'admin', 'running', 'files', ?, ?)`).run(at, at);
  await assert.rejects(() => createTeamBackup({
    db, principal: admin, dataRoot, storageRoot, backupRoot, deploymentId: 'deployment-b01', type: 'manual',
    release: { releaseId: 'release-1', packageSha256: 'a'.repeat(64) },
    config: { version: 'config-1', filePath: media('config-source.json', '{"fixture":true}') },
  }), /清理/);
  db.prepare("UPDATE team_cleanup_jobs SET status = 'completed' WHERE id = 'cleanup-running'").run();

  const barrier = acquireLifecycleBarrier(db, admin, 'backup', { fixture: true });
  assert.throws(() => acquireLifecycleBarrier(db, admin, 'config', { fixture: true }), /屏障/);
  assert.throws(() => registerReadyTeamFile(db, {
    storageRoot, absolutePath: media('media/blocked.bin', 'blocked'), mimeType: 'application/octet-stream',
    ownerUserId: 'admin', references: [{ resourceType: 'project', resourceId: 'project-1' }],
  }), /屏障/);
  assert.equal(releaseLifecycleBarrier(db, admin, barrier.id), true);

  const configPath = path.join(fixtureRoot, 'protected-config.json');
  fs.writeFileSync(configPath, '{"version":"config-1","fixtureSecret":"not-logged"}');
  let copied = 0;
  const result = await createTeamBackup({
    db, principal: admin, dataRoot, storageRoot, backupRoot, deploymentId: 'deployment-b01', type: 'manual',
    release: async () => {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_lifecycle_barriers WHERE releasedAt IS NULL').pluck().get(), 1);
      return { releaseId: 'release-1', packageSha256: 'a'.repeat(64) };
    },
    config: { version: 'config-1', filePath: configPath },
    async copyFile(source, destination) {
      copied += 1;
      if (copied === 1) {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_lifecycle_barriers WHERE releasedAt IS NULL').pluck().get(), 0);
        const response = teamFileResponse(new Request('http://local/file'), db, admin, { storageRoot, fileId: fileA.id });
        assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'immutable-A');
        db.prepare("UPDATE team_files SET state = 'purge_pending' WHERE id = ?").run(fileA.id);
        fs.writeFileSync(configPath, '{"version":"config-2","fixtureSecret":"new"}');
        registerReadyTeamFile(db, {
          storageRoot, absolutePath: media('media/after.bin', 'after'), mimeType: 'application/octet-stream',
          ownerUserId: 'admin', references: [{ resourceType: 'project', resourceId: 'project-1' }],
        });
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    },
  });

  assert.equal(result.manifest.files.length, 1);
  assert.equal(result.manifest.files[0]?.fileId, fileA.id);
  assert.equal(result.manifest.files[0]?.state, 'ready');
  assert.equal(result.manifest.config.version, 'config-1');
  assert.equal(result.manifest.journal.watermarkSeq, 0);
  assert.ok(result.manifest.pin?.id);
  assert.equal(fs.readFileSync(path.join(result.directory, 'config', 'deployment.json'), 'utf8').includes('config-1'), true);
  assert.equal(fs.existsSync(path.join(result.directory, 'files', 'media', 'after.bin')), false);
  assert.equal(fs.readFileSync(path.join(result.directory, 'files', 'media', 'a.bin'), 'utf8'), 'immutable-A');
  assert.equal(JSON.stringify(result.manifest).includes('not-logged'), false);
  const backupDb = new Database(path.join(result.directory, 'data', 'workbench.db'), { readonly: true });
  try {
    assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM team_files').pluck().get(), 1);
  } finally {
    backupDb.close();
  }
  const verification = await verifyTeamBackup(result.directory);
  assert.equal(verification.verified, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'success.json'), 'utf8')).status, 'success');
  const pin = db.prepare('SELECT releasedAt FROM team_backup_pins WHERE id = ?').get(result.manifest.pin!.id) as { releasedAt: string | null };
  assert.equal(pin.releasedAt, null);

  const deferredCleanup = await createTeamBackup({
    db, principal: admin, dataRoot, storageRoot, backupRoot, deploymentId: 'deployment-b01', type: 'manual',
    release: { releaseId: 'release-1', packageSha256: 'a'.repeat(64) },
    config: { version: 'config-2', filePath: configPath }, backupId: 'deferred-cleanup',
  });
  assert.equal(deferredCleanup.manifest.files.find((file) => file.fileId === fileA.id)?.state, 'purge_pending');
  assert.ok(deferredCleanup.manifest.pin?.id, '延期清理文件也必须在解冻前完成 pin');
  assert.equal((await verifyTeamBackup(deferredCleanup.directory)).verified, true);

  const { createMaintenancePreviewReader } = await import('../lib/team-service/maintenance/preview.ts');
  const preview = createMaintenancePreviewReader({ cacheMs: 0 });
  try {
    const request = { kind: 'backups' as const, backupRoot, deploymentId: 'deployment-b01',
      currentRelease: { releaseId: 'release-1', packageSha256: 'a'.repeat(64) } };
    const before = await preview.read(request) as { backups: Array<{ id: string; restorable: boolean }> };
    assert.equal(before.backups.find(item => item.id === result.manifest.backupId)?.restorable, true);
    fs.appendFileSync(path.join(result.directory, 'files', 'media', 'a.bin'), 'tampered');
    const after = await preview.read(request) as { backups: Array<{ id: string; restorable: boolean; verification: string }> };
    assert.equal(after.backups.find(item => item.id === result.manifest.backupId)?.verification, 'invalid');
    assert.equal(after.backups.find(item => item.id === result.manifest.backupId)?.restorable, false);
  } finally { await preview.stop(); }

  console.log('team maintenance backup barrier tests passed');
} finally {
  db.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
