import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    readySeq INTEGER UNIQUE, createdAt TEXT, readyAt TEXT, verifiedIdentityJson TEXT,
    FOREIGN KEY(ownerUserId) REFERENCES team_users(id)
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
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { restoreTeamBackup } = await import('../lib/team-service/maintenance/restore.ts');
const { createTeamBackup, rotateDailyTeamBackups, verifyTeamBackup } = await import('../lib/team-service/maintenance/backup.ts');
const { backupMediaPath } = await import('../lib/team-service/maintenance/daily-media.ts');
const { resumeDailyRetirements } = await import('../lib/team-service/maintenance/daily-retirement.ts');
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
function input(type: 'daily' | 'manual' | 'pre-upgrade' | 'pre-restore', backupId: string) {
  sequence += 1;
  const at = new Date(2026, 0, sequence, 12);
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
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  db.exec('CREATE TABLE daily_value(day INTEGER); INSERT INTO daily_value VALUES (0)');
  const changingPath = path.join(storageRoot, 'media', 'version.bin');
  const addFile = (name: string, contents: string) => {
    const absolutePath = path.join(storageRoot, 'media', name);
    fs.writeFileSync(absolutePath, contents);
    return registerReadyTeamFile(db, { storageRoot, absolutePath, mimeType: 'application/octet-stream', ownerUserId: 'admin',
      references: [{ resourceType: 'project', resourceId: 'project-1' }] });
  };
  const changing = addFile('version.bin', 'A');
  // 同长度、同路径的新内容，以及后来才出现的素材，各自只在首次出现时写入。
  let firstOnlyObject = '';
  let mutableObject = '';
  for (let index = 1; index <= 15; index += 1) {
    db.prepare('UPDATE daily_value SET day = ?').run(index);
    fs.writeFileSync(configPath, JSON.stringify({ day: index }));
    if (index === 2 || index === 7) {
      const contents = index === 2 ? 'B' : 'C';
      fs.writeFileSync(changingPath, contents);
      db.prepare('UPDATE team_files SET sha256 = ? WHERE id = ?').run(createHash('sha256').update(contents).digest('hex'), changing.id);
    }
    if (index === 6) addFile('new.bin', 'added-on-six');
    if (index === 10) {
      fs.renameSync(path.join(storageRoot, 'media', 'new.bin'), path.join(storageRoot, 'media', 'renamed.bin'));
      db.prepare("UPDATE team_files SET relativePath='media/renamed.bin' WHERE relativePath='media/new.bin'").run();
    }
    const backupId = `daily-${String(index).padStart(2, '0')}`;
    const result = await createTeamBackup(input('daily', backupId));
    const written = index === 1 ? Buffer.byteLength('shared-production-object') + 1
      : index === 6 ? Buffer.byteLength('added-on-six') : index === 2 || index === 7 ? 1 : 0;
    assert.equal(result.success.newMediaBytes, written);
    const changingEntry = result.manifest.files.find(file => file.fileId === changing.id)!;
    mutableObject = backupMediaPath(result.directory, result.manifest, changingEntry);
    if (index === 1) firstOnlyObject = mutableObject;
    if (index === 15) {
      assert.deepEqual(result.rotation?.deletedBackupIds, ['daily-01']);
      assert.equal(fs.readFileSync(backupMediaPath(result.directory, result.manifest, result.manifest.files.find(file => file.relativePath === 'media/shared.bin')!), 'utf8'), 'shared-production-object');
    }
  }
  assert.equal(publishedIds('daily').length, 14);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-01')), false);
  assert.equal(fs.readFileSync(path.join(storageRoot, 'media', 'shared.bin'), 'utf8'), 'shared-production-object');

  assert.equal(fs.existsSync(firstOnlyObject), false, '最后一个引用过期后才回收媒体内容');
  const dailyInput = input('daily', 'same-day');
  const replayTime = new Date(2026, 0, 15, 19);
  const rerun = await createTeamBackup({ ...dailyInput, now: () => replayTime,
    copyFile: async () => assert.fail('内容全部相同的日备不应再复制媒体字节'),
  });
  assert.deepEqual(rerun.rotation?.deletedBackupIds, ['daily-15']);
  assert.equal(rerun.success.newMediaBytes, 0);
  assert.equal(publishedIds('daily').length, 14);

  for (let day = 2; day <= 15; day++) {
    const id = day === 15 ? 'same-day' : `daily-${String(day).padStart(2, '0')}`;
    const restoreRoot = path.join(fixtureRoot, `restore-day-${day}`);
    await restoreTeamBackup({ backupDirectory: path.join(backupRoot, 'daily', id), restoreRoot,
      deploymentId: dailyInput.deploymentId, expectedReleaseId: release.releaseId });
    const snapshot = new Database(path.join(restoreRoot, 'data', 'workbench.db'), { readonly: true });
    try { assert.equal(snapshot.prepare('SELECT day FROM daily_value').pluck().get(), day); }
    finally { snapshot.close(); }
    assert.equal(JSON.parse(fs.readFileSync(path.join(restoreRoot, 'config', 'deployment.json'), 'utf8')).day, day);
    const mediaDir = path.join(restoreRoot, 'storage', 'media');
    assert.equal(fs.readFileSync(path.join(mediaDir, 'shared.bin'), 'utf8'), 'shared-production-object');
    assert.equal(fs.readFileSync(path.join(mediaDir, 'version.bin'), 'utf8'), day < 7 ? 'B' : 'C');
    assert.equal(fs.existsSync(path.join(mediaDir, 'new.bin')), day >= 6 && day < 10);
    assert.equal(fs.existsSync(path.join(mediaDir, 'renamed.bin')), day >= 10);
  }

  // 相同大小的损坏也必须检出；修复共享对象后历史还原点一并恢复可读。
  fs.writeFileSync(mutableObject, '!');
  assert.equal((await verifyTeamBackup(rerun.directory)).verified, false);
  const repair = await createTeamBackup({ ...dailyInput, backupId: 'repair', now: () => new Date(2026, 0, 15, 20) });
  assert.equal(repair.success.newMediaBytes, 1);
  assert.equal((await verifyTeamBackup(path.join(backupRoot, 'daily', 'daily-07'))).verified, true);
  // 日备 v1 与手动备份的目录格式相同。模拟升级前的 daily，走真实校验和还原入口。
  const manual = await createTeamBackup(input('manual', 'manual-keep'));
  const legacyDir = path.join(fixtureRoot, 'legacy-backups', 'daily', manual.manifest.backupId);
  fs.cpSync(manual.directory, legacyDir, { recursive: true });
  const legacyManifest = JSON.stringify({ ...manual.manifest, type: 'daily' });
  fs.writeFileSync(path.join(legacyDir, 'manifest.json'), legacyManifest);
  fs.writeFileSync(path.join(legacyDir, 'success.json'), JSON.stringify({
    ...manual.success, type: 'daily', manifestSha256: createHash('sha256').update(legacyManifest).digest('hex'),
  }));
  const legacyRoot = path.join(fixtureRoot, 'legacy-restore');
  await restoreTeamBackup({ backupDirectory: legacyDir, restoreRoot: legacyRoot, deploymentId: dailyInput.deploymentId,
    expectedReleaseId: release.releaseId });
  assert.equal(fs.readFileSync(path.join(legacyRoot, 'storage', 'media', 'version.bin'), 'utf8'), 'C');
  await createTeamBackup(input('pre-upgrade', 'pre-upgrade-keep'));
  await createTeamBackup(input('pre-restore', 'pre-restore-keep'));
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
  assert.deepEqual(publishedIds('pre-restore'), ['pre-restore-keep']);
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-16', 'success.json')), true);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'data', 'backups')), false, 'schema-upgrade 区域不属于 daily 轮换');
  // 模拟日备选中到期项后，进程分别在移出前、移出后和删除内容后中断。
  const retryRoot = path.join(fixtureRoot, 'retirement-retry');
  const retryId = 'repair-fixture';
  const retryJob = path.join(retryRoot, 'daily-retired-v1', 'deployment-rotation', retryId);
  const visible = path.join(retryRoot, 'daily', retryId);
  fs.mkdirSync(retryJob, { recursive: true });
  fs.mkdirSync(path.join(visible, 'config'), { recursive: true });
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const intent = { version: 1, backupId: retryId, deploymentId: 'deployment-rotation',
    manifestSha256: digest('{}'), configSha256: digest('fixture'), pinId: 'expired-pin' };
  fs.writeFileSync(path.join(retryJob, 'intent.json'), JSON.stringify(intent));
  fs.writeFileSync(path.join(visible, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(visible, 'config', 'deployment.json'), 'changed');
  const released: string[] = [];
  const resume = () => resumeDailyRetirements(retryRoot, 'deployment-rotation', id => { released.push(id); });
  await resume();
  assert.ok(fs.existsSync(visible));
  assert.deepEqual(released, []);
  const detached = path.join(retryJob, 'snapshot');
  fs.renameSync(visible, detached);
  await assert.rejects(resume, /到期配置/);
  assert.deepEqual(released, []);
  fs.writeFileSync(path.join(detached, 'config', 'deployment.json'), 'fixture');
  await resumeDailyRetirements(retryRoot, 'deployment-rotation', undefined);
  assert.equal(fs.existsSync(detached), false);
  assert.ok(fs.existsSync(path.join(retryJob, 'intent.json')));
  await resume();
  await resume();
  assert.deepEqual(released, ['expired-pin']);
  assert.equal(fs.existsSync(retryJob), false);
  const receipt = fs.readFileSync(path.join(backupRoot, 'maintenance-receipts', 'deployment-rotation.jsonl'), 'utf8');
  assert.match(receipt, /"phase":"failed"/);
  assert.match(receipt, /"backupId":"daily-16"/);
  assert.doesNotMatch(receipt, /fixtureSecret|apiKey|token/i);

  const priorIds = publishedIds('daily');
  const uncommitted = addFile('a-first.bin', 'new-uncommitted');
  addFile('b-fail.bin', 'read-error');
  await assert.rejects(() => createTeamBackup({ ...input('daily', 'partial'), async copyFile(source, destination) {
    if (source.endsWith('b-fail.bin')) throw new Error('injected copy failure');
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } }), /injected copy failure/);
  assert.deepEqual(publishedIds('daily'), priorIds, '失败不能淘汰任何成功日');
  const orphan = path.join(backupRoot, 'daily-media-v1', dailyInput.deploymentId, uncommitted.sha256.slice(0, 2), uncommitted.sha256);
  assert.equal(fs.existsSync(orphan), false, '部分写入失败后回收无引用对象');
  assert.equal((await verifyTeamBackup(path.join(backupRoot, 'daily', 'daily-07'))).verified, true);

  const interrupted = path.join(backupRoot, 'daily', '.interrupted-v2.staging');
  fs.mkdirSync(interrupted);
  fs.writeFileSync(path.join(interrupted, 'maintenance-staging.json'), JSON.stringify({
    schemaVersion: 1, mediaStoreVersion: 1, type: 'daily', backupId: 'interrupted-v2', nonce: 'fixture-nonce',
    deploymentId: dailyInput.deploymentId, dataRootIdentity: createHash('sha256').update(path.resolve(dataRoot)).digest('hex'),
  }));
  fs.writeFileSync(path.join(interrupted, 'media-object.tmp'), 'partial');
  fs.writeFileSync(orphan, 'new-uncommitted');
  await assert.rejects(() => createTeamBackup({ ...input('daily', 'after-crash'), diskSpaceProbe: async () => {
    assert.equal(fs.existsSync(interrupted), false);
    assert.equal(fs.existsSync(orphan), false);
    return 0;
  } }), /空间不足/);
  assert.deepEqual(publishedIds('daily'), priorIds);

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
