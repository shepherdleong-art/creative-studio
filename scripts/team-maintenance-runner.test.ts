import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { writeReleaseManifest } from './team-server/distribution.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-runner-'));
const deploymentRoot = path.join(fixture, 'deployment');
const dataRoot = path.join(fixture, 'data');
const backupRoot = path.join(fixture, 'backup');
const releaseRoot = path.join(deploymentRoot, 'releases', 'release-1');
const deploymentId = 'deployment-runner';
const configPath = path.join(fixture, 'deployment.json');
const runner = path.resolve('scripts/team-server/maintenance.mjs');
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const databases = new Set<Database.Database>();
const jobStores = new Set<{ close(): void }>();

function write(relative: string, content: string): string {
  const file = path.join(releaseRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeFixtureRelease(): void {
  write('app/server.js', '// fixture\n');
  write('runtime/process-tree.mjs', '// fixture\n');
  const node = write('runtimes/node/node.exe', 'fixture node');
  const caddy = write('tools/caddy/caddy.exe', 'fixture caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'fixture winsw');
  const lock = JSON.parse(fs.readFileSync(path.resolve('scripts/team-server/distribution-lock.json'), 'utf8')) as {
    fixture: boolean; media: unknown[];
    node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
  };
  lock.fixture = true;
  lock.media = [];
  lock.node.binarySha256 = sha256(node);
  lock.caddy.binarySha256 = sha256(caddy);
  lock.winsw.sha256 = sha256(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync(path.resolve('scripts/packaging/forbidden-paths.json'), 'utf8'));
  write('START-HERE.md', '# fixture server package\n');
  write('deployment.example.json', '{"schemaVersion":1}\n');
  writeReleaseManifest(releaseRoot, { releaseId: 'release-1', appVersion: '0.7.1', sourceCommit: 'fixture', fixture: true });
}

function invoke(...args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true, timeout: 120_000,
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot },
  });
}

try {
  makeFixtureRelease();
  const config = {
    schemaVersion: 1,
    deploymentId,
    releaseId: 'release-1',
    deploymentRoot,
    dataRoot,
    backupRoot,
    oldRoots: [path.join(fixture, 'old')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudioRunner',
    serviceAccount: 'NT AUTHORITY\\NetworkService',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: false,
    stopTimeoutSeconds: 240,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
  const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES ('admin', 'admin', 'Admin', 'admin', 'active', 'fixture', 0, 1, ?, ?)`).run(at, at);
  const journalDirectory = path.join(dataRoot, 'storage', 'execution-journal', deploymentId);
  fs.mkdirSync(journalDirectory, { recursive: true });

  const { MaintenanceJobStore } = await import('../lib/team-service/maintenance/jobs.ts');
  const jobs = new MaintenanceJobStore({ backupRoot, deploymentId });
  const submitted = jobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' },
    idempotencyKey: 'frontend-request-10',
  });
  assert.equal(submitted.job.progress, null);
  const worker = invoke('worker', '--config', configPath, '--job-id', submitted.job.id, '--once', '--allow-fixture-release');
  assert.equal(worker.status, 0, `${worker.stdout}${worker.stderr}`);
  const finished = jobs.get(submitted.job.id).job;
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.requestedBy.displayName, '真实网页管理员');
  const manualBackupId = String(finished.result?.backupId);
  assert.ok(manualBackupId);
  const manualDirectory = path.join(backupRoot, 'manual', manualBackupId);
  const { verifyTeamBackup } = await import('../lib/team-service/maintenance/backup.ts');
  assert.equal((await verifyTeamBackup(manualDirectory)).verified, true);
  const { listTeamBackups } = await import('../lib/team-service/maintenance/catalog.ts');
  assert.equal((await listTeamBackups(backupRoot, deploymentId)).backups.find((backup) => backup.id === manualBackupId)?.restorable, true);
  const manualDb = new Database(path.join(manualDirectory, 'data', 'workbench.db'), { readonly: true });
  databases.add(manualDb);
  assert.equal(manualDb.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(manualDb.prepare("SELECT displayName FROM team_users WHERE id = 'admin'").pluck().get(), 'Admin');
  const persistedBackupPin = db.prepare('SELECT ownerUserId FROM team_backup_pins ORDER BY createdAt DESC LIMIT 1').get() as { ownerUserId: string } | undefined;
  assert.equal(persistedBackupPin, undefined, '空媒体快照不应伪造 pin');
  assert.equal(jobs.audit(submitted.job.id).some((record) => record.event === 'verifying'), true);
  const repeated = invoke('worker', '--config', configPath, '--job-id', submitted.job.id, '--once', '--allow-fixture-release');
  assert.equal(repeated.status, 0, `${repeated.stdout}${repeated.stderr}`);
  assert.equal(fs.readdirSync(path.join(backupRoot, 'manual')).length, 1, '重复领取不得重复备份');
  const duplicate = jobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' },
    idempotencyKey: 'frontend-request-10',
  });
  assert.equal(duplicate.job.id, submitted.job.id);
  assert.equal(duplicate.created, false);
  jobs.close();

  const { acquireSchemaUpgradeLock } = await import('../lib/schema-upgrade/lock.ts');
  const { maintenanceGlobalLockPath } = await import('../lib/team-service/maintenance/worker.ts');
  const globalLock = await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(backupRoot) });
  const blockedJobs = new MaintenanceJobStore({ backupRoot, deploymentId });
  blockedJobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' }, idempotencyKey: 'blocked-global-lock-10',
  });
  blockedJobs.close();
  const overlappingWeb = invoke('worker', '--config', configPath, '--once', '--allow-fixture-release');
  assert.notEqual(overlappingWeb.status, 0, '全局维护锁被持有时不能另起网页备份');
  assert.match(overlappingWeb.stderr, /维护|锁|冲突/);
  const overlappingDaily = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-locked-global', '--allow-fixture-release');
  assert.notEqual(overlappingDaily.status, 0, '定时备份也必须服从全局维护锁');
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-locked-global')), false);
  globalLock.release();
  const heldJobs = new MaintenanceJobStore({ backupRoot, deploymentId });
  const resumedBlocked = invoke('worker', '--config', configPath, '--once', '--allow-fixture-release');
  assert.equal(resumedBlocked.status, 0, resumedBlocked.stderr);
  assert.equal(heldJobs.list().jobs.find((job) => job.status === 'queued'), undefined);
  const waiting = heldJobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' }, idempotencyKey: 'waiting-for-global-lock',
  });
  const held = await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(backupRoot) });
  const waitingWorker = invoke('worker', '--config', configPath, '--once', '--allow-fixture-release');
  held.release();
  assert.notEqual(waitingWorker.status, 0, '锁冲突必须明确退出，不得假成功');
  assert.equal(heldJobs.get(waiting.job.id).job.status, 'queued', '锁冲突必须保留原作业等待重试，不能伪造失败或成功');
  const resumed = invoke('worker', '--config', configPath, '--once', '--allow-fixture-release');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(heldJobs.get(waiting.job.id).job.status, 'succeeded');
  heldJobs.close();

  const failedJobs = new MaintenanceJobStore({ backupRoot, deploymentId });
  const failedSubmission = failedJobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' }, idempotencyKey: 'disk-space-failure-10',
  });
  const diskFailure = invoke('worker', '--config', configPath, '--job-id', failedSubmission.job.id, '--once', '--test-disk-space-zero', '--allow-fixture-release');
  assert.notEqual(diskFailure.status, 0);
  const failedJob = failedJobs.get(failedSubmission.job.id).job;
  assert.equal(failedJob.status, 'failed');
  assert.match(failedJob.error?.message ?? '', /空间不足/);
  assert.equal(failedJob.result, null);
  assert.equal(fs.existsSync(path.join(backupRoot, 'manual', `job-${failedSubmission.job.id}`)), false);
  assert.equal((await listTeamBackups(backupRoot, deploymentId)).backups.some((backup) => backup.id === `job-${failedSubmission.job.id}`), false);
  assert.equal(failedJobs.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' }, idempotencyKey: 'disk-space-failure-10',
  }).job.id, failedSubmission.job.id);
  failedJobs.close();

  const restoreJobs = new MaintenanceJobStore({ backupRoot, deploymentId });
  jobStores.add(restoreJobs);
  const restoreSubmission = restoreJobs.submit({
    action: 'restore.execute', target: { kind: 'restore', backupType: 'manual', backupId: manualBackupId },
    principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' }, idempotencyKey: 'full-restore-operation-13',
  });
  const prepare = invoke('worker', '--config', configPath, '--job-id', restoreSubmission.job.id, '--once', '--allow-fixture-release', '--test-isolated-cutover');
  assert.equal(prepare.status, 0, `${prepare.stdout}${prepare.stderr}`);
  const waitingRestore = restoreJobs.get(restoreSubmission.job.id).job;
  assert.equal(waitingRestore.status, 'awaiting_confirmation');
  assert.equal(waitingRestore.result?.awaitingConfirmation, true);
  assert.ok(waitingRestore.result?.preRestoreBackupId);
  assert.equal(restoreJobs.audit(restoreSubmission.job.id)[0]?.actor.displayName, '真实网页管理员');
  const repeatWaiting = invoke('worker', '--config', configPath, '--job-id', restoreSubmission.job.id, '--once', '--allow-fixture-release', '--test-isolated-cutover');
  assert.equal(repeatWaiting.status, 0, `${repeatWaiting.stdout}${repeatWaiting.stderr}`);
  assert.equal(restoreJobs.get(restoreSubmission.job.id).job.status, 'awaiting_confirmation');
  restoreJobs.confirm({ jobId: restoreSubmission.job.id, principal: { userId: 'admin', employeeId: '00042', displayName: '真实网页管理员', role: 'admin' } });
  const cutover = invoke('worker', '--config', configPath, '--job-id', restoreSubmission.job.id, '--once', '--allow-fixture-release', '--test-isolated-cutover');
  assert.notEqual(cutover.status, 0, '未经受控重新认证不得实际切换');
  assert.equal(restoreJobs.get(restoreSubmission.job.id).job.status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).dataRoot, dataRoot);
  restoreJobs.close();

  const first = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-1', '--allow-fixture-release');
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.equal(JSON.parse(first.stdout.trim()).status, 'success');
  const dailyJobPath = path.join(backupRoot, 'daily-job.json');
  let dailyJob = JSON.parse(fs.readFileSync(dailyJobPath, 'utf8'));
  assert.equal(dailyJob.status, 'success');
  assert.equal(dailyJob.backupId, 'daily-1');
  assert.ok(dailyJob.durationMs >= 0);
  assert.ok(dailyJob.totalBytes > 0);
  assert.ok(dailyJob.availableBytes > 0);
  assert.equal(dailyJob.latestRecoveryEvidence.backupId, manualBackupId);
  assert.notDeepEqual([...fs.readFileSync(dailyJobPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const lockFile = path.join(backupRoot, 'locks', 'daily.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ schemaVersion: 1, pid: 1, startedAt: new Date().toISOString() }));
  const overlapping = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-locked', '--allow-fixture-release');
  assert.equal(overlapping.status, 0, `${overlapping.stdout}${overlapping.stderr}`);
  assert.equal(JSON.parse(overlapping.stdout.trim()).status, 'skipped');
  assert.equal(fs.existsSync(path.join(backupRoot, 'daily', 'daily-locked')), false, '重叠执行不得产生第二份备份');
  assert.equal(JSON.parse(fs.readFileSync(dailyJobPath, 'utf8')).backupId, 'daily-1', '重叠执行不得覆盖最近成功状态');
  const stale = new Date(Date.now() - 13 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, stale, stale);
  const recovered = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-stale', '--allow-fixture-release');
  assert.equal(recovered.status, 0, `${recovered.stdout}${recovered.stderr}`);
  assert.equal(JSON.parse(recovered.stdout.trim()).status, 'success', '过期锁必须可自愈');
  assert.equal(fs.existsSync(lockFile), false, '成功或失败后都必须释放每日锁');

  const serviceRoot = path.join(deploymentRoot, 'service');
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, 'current-release.json'), JSON.stringify({
    schemaVersion: 1, releaseId: 'release-1', packageSha256: sha256(path.join(releaseRoot, 'release-manifest.json')),
    switchedAt: new Date().toISOString(),
  }));
  const staleConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { releaseId: string };
  staleConfig.releaseId = 'stale-release-not-installed';
  fs.writeFileSync(configPath, JSON.stringify(staleConfig));

  const restoreRoot = path.join(fixture, 'restored');
  const restored = invoke('restore', '--config', configPath, '--backup-type', 'daily', '--backup-id', 'daily-1',
    '--restore-root', restoreRoot, '--allow-fixture-release');
  assert.equal(restored.status, 0, `${restored.stdout}${restored.stderr}`);
  const restoreResult = JSON.parse(restored.stdout.trim());
  assert.equal(restoreResult.status, 'reconciled');
  assert.equal(restoreResult.scheduling, false);
  assert.equal(restoreResult.automaticRetries, 0);
  assert.equal(fs.existsSync(path.join(restoreRoot, 'storage', 'maintenance', 'restore-hold.json')), true);

  const second = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-2', '--allow-fixture-release');
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  const secondManifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'daily', 'daily-2', 'manifest.json'), 'utf8'));
  assert.equal(secondManifest.release.releaseId, 'release-1', '备份必须固定 current release，而非过期配置 releaseId');
  dailyJob = JSON.parse(fs.readFileSync(dailyJobPath, 'utf8'));
  assert.equal(dailyJob.backupId, 'daily-2');
  assert.equal(dailyJob.latestRecoveryEvidence.backupId, 'daily-1');
  assert.equal(dailyJob.latestRecoveryEvidence.evidenceStatus, 'complete');
  assert.doesNotMatch(first.stdout + first.stderr + restored.stdout + restored.stderr + second.stdout + second.stderr,
    /fixtureSecret|apiKey|Bearer\s+/i);
  console.log('team maintenance runner daily job and restore tests passed');
} catch (error) {
  console.error('maintenance runner assertion', error);
  throw error;
} finally {
  for (const store of jobStores) store.close();
  for (const db of databases) if (db.open) db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
