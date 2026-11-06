#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { resolveDeploymentConfig } from './generate-config.mjs';
import { sha256File, verifyReleaseManifest } from './distribution.mjs';
import { runControlledServiceAction } from './service-control.mjs';
import { createTeamBackup, verifyTeamBackup } from '../../lib/team-service/maintenance/backup.ts';
import { MaintenanceJobStore } from '../../lib/team-service/maintenance/jobs.ts';
import { runMaintenanceWorker, maintenanceGlobalLockPath } from '../../lib/team-service/maintenance/worker.ts';
import { acquireSchemaUpgradeLock } from '../../lib/schema-upgrade/lock.ts';
import { restoreTeamBackup } from '../../lib/team-service/maintenance/restore.ts';
import { runTeamRelease, rollbackTeamRelease, readTeamReleasePointer, switchTeamReleasePointerIdempotent } from '../../lib/team-service/maintenance/release.ts';
import { acquireLifecycleBarrier, releaseLifecycleBarrier } from '../../lib/team-service/lifecycle/index.ts';
import { createExecutionJournal } from '../../lib/media-core/execution/journal.ts';
import { getTeamReleaseCandidateForExecution } from '../../lib/team-service/maintenance/release-candidates.ts';
import { materializeTeamReleaseCandidate } from '../../lib/team-service/maintenance/release-install.ts';
import { teamMaintenanceStateDirectory } from '../../lib/team-service/maintenance/state.ts';
import { executeTeamRestoreOperation } from '../../lib/team-service/maintenance/restore-operation.ts';
import { executeCleanupPreview } from '../../lib/team-service/maintenance/cleanup.ts';

const args = process.argv.slice(2);
const command = args[0];
function argument(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) throw new Error('维护标识无效');
  return value;
}
function openDatabase(dataRoot, readonly = false) {
  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'), { readonly, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}
function adminPrincipal(db) {
  const row = db.prepare("SELECT id FROM team_users WHERE role = 'admin' AND status = 'active' ORDER BY createdAt LIMIT 1").get();
  if (!row) throw new Error('没有可用于维护的有效管理员');
  return { userId: row.id, role: 'admin' };
}
function releaseIdentity(config, releaseId, allowFixture = false) {
  safeId(releaseId);
  const releaseRoot = path.join(config.deploymentRoot, 'releases', releaseId);
  verifyReleaseManifest(releaseRoot, { allowFixture });
  return {
    releaseId,
    packageSha256: sha256File(path.join(releaseRoot, 'release-manifest.json')),
  };
}
async function currentReleaseIdentity(config) {
  const pointer = path.join(config.serviceRoot, 'current-release.json');
  if (!fs.existsSync(pointer)) return releaseIdentity(config, config.releaseId, args.includes('--allow-fixture-release'));
  const current = await readTeamReleasePointer(config.serviceRoot);
  const verified = releaseIdentity(config, current.releaseId, args.includes('--allow-fixture-release'));
  if (verified.packageSha256 !== current.packageSha256) throw new Error('当前 release 指针与不可变包哈希不符');
  return verified;
}
function credential(config) {
  const file = config.controlCredentialFile;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('控制凭据必须是受保护普通文件');
  return readJson(file);
}
function serviceAccountText(config) {
  if (args.includes('--test-isolated-cutover') && process.platform === 'win32') return '*S-1-5-18';
  return typeof config.serviceAccount === 'string'
    ? config.serviceAccount
    : `${config.serviceAccount.domain}\\${config.serviceAccount.user}`;
}
function resolvedFor(config, releaseId = config.releaseId) {
  return resolveDeploymentConfig({ ...config, releaseId, serviceAccount: serviceAccountText(config) });
}
async function controlled(action, config, releaseId = config.releaseId) {
  return runControlledServiceAction({
    action,
    config: resolvedFor(config, releaseId),
    credential: credential(resolvedFor(config)),
    apply: true,
    forceAfterTimeout: action === 'stop',
  });
}
function startApp(config) {
  if (process.platform !== 'win32') throw new Error('SCM 启动只可在目标 Windows 主机显式执行');
  const app = resolvedFor(config).services.find((service) => service.role === 'app');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Start-Service -Name $env:CREATIVE_STUDIO_EXACT_APP_SERVICE -ErrorAction Stop',
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CREATIVE_STUDIO_EXACT_APP_SERVICE: app.id },
  });
  if (result.status !== 0) throw new Error('精确 app SCM 服务启动失败');
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitService(config, releaseId, expected) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const status = await controlled('status', config, releaseId);
      if (expected === 'maintenance' && status.maintenance === true && status.ready === false) return status;
      if (expected === 'ready' && status.maintenance === false && status.ready === true) return status;
    } catch {}
    await delay(500);
  }
  throw new Error(`服务未进入 ${expected} 状态`);
}
function protectConfig(config) {
  return async (file) => {
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
      return;
    }
    const account = serviceAccountText(config);
    const identity = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (identity.status !== 0 || !identity.stdout.trim()) throw new Error('无法确认当前维护账号，拒绝设置配置 ACL');
    const result = spawnSync('icacls.exe', [
      file, '/inheritance:r', '/grant:r', `${identity.stdout.trim()}:F`,
      '*S-1-5-18:F', '*S-1-5-32-544:F', `${account}:R`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (result.status !== 0) throw new Error(`秘密配置副本 ACL 设置失败：${(result.stderr || result.stdout || '').trim().slice(-300)}`);
  };
}
function latestRecoveryEvidence(config) {
  const file = path.join(config.backupRoot, 'maintenance-receipts', `${config.deploymentId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const records = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line));
  const recovery = records.reverse().find((record) => record.kind === 'restore' && record.phase === 'finished');
  return recovery ? { at: recovery.at, backupId: recovery.backupId, evidenceStatus: recovery.evidenceStatus } : null;
}
function writeDailyJob(config, value) {
  const file = path.join(config.backupRoot, 'daily-job.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    latestRecoveryEvidence: latestRecoveryEvidence(config),
    ...value,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function backupDirectory(config, type, backupId) {
  safeId(backupId);
  if (!['daily', 'manual', 'pre-upgrade', 'pre-restore'].includes(type)) throw new Error('备份类型无效');
  const root = path.resolve(config.backupRoot, type);
  const directory = path.resolve(root, backupId);
  if (path.dirname(directory).toLowerCase() !== root.toLowerCase()) throw new Error('备份路径越界');
  return directory;
}
function acquireDailyLock(config) {
  const directory = path.join(config.backupRoot, 'locks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'daily.lock');
  const staleBefore = Date.now() - 12 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(file);
        stale = stat.mtimeMs < staleBefore;
      } catch {}
      if (!stale || attempt > 0) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}
function compatibilityReport(file) {
  if (!file) throw new Error('更新/兼容回切必须提供隔离验证兼容性报告');
  const report = readJson(path.resolve(file));
  if (report.isolatedVerified !== true || typeof report.schemaCompatible !== 'boolean'
    || typeof report.irreversibleChanges !== 'boolean') throw new Error('兼容性报告缺少隔离验证或兼容结论');
  return report;
}
function dbVersion(dataRoot) {
  const db = openDatabase(dataRoot);
  try {
    const version = db.prepare('SELECT MAX(version) AS version FROM team_schema_migrations').pluck().get();
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('当前数据版本无法复核');
    return version;
  } finally { db.close(); }
}
function setMaintenance(db, maintenance, reason) {
  db.prepare('UPDATE team_service_state SET maintenance = ?, reason = ?, updatedAt = ? WHERE id = 1')
    .run(maintenance ? 1 : 0, reason, new Date().toISOString());
}
function captureExecution(config, db, operationId) {
  const journal = createExecutionJournal({
    deploymentId: config.deploymentId,
    directory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
  });
  const records = journal.scan();
  const evidence = {
    schemaVersion: 1,
    operationId,
    capturedAt: new Date().toISOString(),
    operations: db.prepare('SELECT * FROM execution_operations').all(),
    attempts: db.prepare('SELECT * FROM execution_attempts').all(),
    reservations: db.prepare('SELECT * FROM execution_reservations').all(),
    journalRecords: records,
  };
  const directory = path.join(config.deploymentRoot, 'service', 'maintenance-evidence');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${safeId(operationId)}.json`);
  if (fs.existsSync(file)) {
    const existing = readJson(file);
    if (existing.operationId !== operationId || !Array.isArray(existing.operations)) throw new Error('既有执行证据身份不符');
    return { evidenceSha256: sha256File(file), operationCount: existing.operations.length };
  }
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { evidenceSha256: sha256File(file), operationCount: evidence.operations.length };
}
async function drain(db) {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const pendingTasks = db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE submissionState IN ('not_sent', 'maybe_sent', 'accepted')").pluck().get();
    if (pendingTasks === 0) {
      const unknownAttemptIds = db.prepare("SELECT currentAttemptId AS id FROM execution_operations WHERE status = 'unknown' AND currentAttemptId IS NOT NULL")
        .all().map((row) => row.id);
      return { pendingTasks: 0, unknownAttemptIds };
    }
    await delay(250);
  }
  return { pendingTasks: 1, unknownAttemptIds: [] };
}
async function activateRestoredService(config, restoredDataRoot, jobId) {
  const { generateDeploymentConfiguration } = await import('./generate-config.mjs');
  const current = readJson(configPathForMaintenance(config));
  const resolvedPath = path.join(config.serviceRoot, 'resolved-services.json');
  const previousResolved = fs.readFileSync(resolvedPath, 'utf8');
  const nextConfig = { ...current, dataRoot: restoredDataRoot };
  try {
    generateDeploymentConfiguration(nextConfig, config.serviceRoot);
    const resolved = readJson(resolvedPath);
    if (resolved.dataRoot !== restoredDataRoot) throw new Error('受管数据根指针未指向已验证还原根');
    if (args.includes('--test-cutover-failure')) throw new Error('injected activation failure');
    startApp(config);
    await waitService(config, config.releaseId, 'maintenance');
    const temporary = `${configPathForMaintenance(config)}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configPathForMaintenance(config));
    return resolved.dataRoot;
  } catch (error) {
    fs.writeFileSync(resolvedPath, previousResolved);
    if (args.includes('--test-cutover-failure')) throw error;
    // 真实 SCM 启动失败时先停止可能已启动的新根，再恢复旧配置。
    try { await controlled('stop', config, current.releaseId); } catch { /* 启动失败后实例可能已不在运行。 */ }
    generateDeploymentConfiguration(readJson(configPathForMaintenance(config)), config.serviceRoot);
    startApp(config);
    await waitService(config, config.releaseId, 'maintenance');
    throw error;
  }
}
function configPathForMaintenance(config) {
  return path.join(config.configRoot, 'maintenance-deployment.json');
}
async function makeBackup(config, db, principal, type, backupId, configPath, reuseExisting = false, lockAlreadyHeld = false, onStage) {
  const lock = lockAlreadyHeld ? null : await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(config.backupRoot), timeoutMs: 100 });
  try {
  const release = await currentReleaseIdentity(config);
  if (backupId && reuseExisting) {
    const directory = backupDirectory(config, type, backupId);
    if (fs.existsSync(directory)) {
      const verification = await verifyTeamBackup(directory);
      if (!verification.verified || verification.manifest.deploymentId !== config.deploymentId
        || verification.manifest.release.releaseId !== release.releaseId
        || verification.manifest.release.packageSha256 !== release.packageSha256) {
        throw new Error('既有 pre-upgrade 备份身份或完整性不符，拒绝复用');
      }
      return {
        directory,
        manifest: verification.manifest,
        success: readJson(path.join(directory, 'success.json')),
      };
    }
  }
  return createTeamBackup({
    db, principal, dataRoot: config.dataRoot, storageRoot: path.join(config.dataRoot, 'storage'),
    backupRoot: config.backupRoot, deploymentId: config.deploymentId, type,
    release: async () => {
      const pointer = path.join(config.serviceRoot, 'current-release.json');
      if (fs.existsSync(pointer)) {
        const current = await readTeamReleasePointer(config.serviceRoot);
        if (current.releaseId !== release.releaseId || current.packageSha256 !== release.packageSha256) {
          throw new Error('备份屏障建立前 current release 已变化，拒绝混用快照身份');
        }
      }
      return release;
    },
    config: { filePath: configPath }, ...(backupId ? { backupId } : {}),
    protectConfig: protectConfig(config),
    ...(args.includes('--test-disk-space-zero') ? { diskSpaceProbe: async () => 0 } : {}),
    ...(onStage ? { onStage } : {}),
  });
  } finally { lock?.release(); }
}
async function resumeService(config, db, releaseId) {
  const stopped = await controlled('stop', config, releaseId);
  if (!stopped.stopped) throw new Error('恢复接单前旧维护实例未退出');
  startApp({ ...config, releaseId });
  await waitService(config, releaseId, 'maintenance');
  setMaintenance(db, false, '');
  await waitService(config, releaseId, 'ready');
}

try {
  const configPath = path.resolve(required('--config'));
  const config = resolveDeploymentConfig(readJson(configPath));
  if (command === 'worker') {
    await runMaintenanceWorker({
      configPath,
      once: args.includes('--once'),
      jobId: argument('--job-id') || undefined,
      executeRelease: async ({ job, onStage }) => {
        if (job.target.kind !== 'release') throw new Error('升级目标无效');
        const operationId = job.id;
        const allowFixture = args.includes('--allow-fixture-release');
        const stateDirectory = teamMaintenanceStateDirectory(config.backupRoot, config.deploymentId);
        const persistedPath = path.join(stateDirectory, `${operationId}.json`);
        const persisted = fs.existsSync(persistedPath) ? readJson(persistedPath) : null;
        const pointerNow = await currentReleaseIdentity(config);
        const current = persisted?.fromRelease ?? pointerNow;
        if (persisted && (persisted.fromRelease.releaseId !== pointerNow.releaseId
          && persisted.toRelease.releaseId !== pointerNow.releaseId)) throw new Error('实际版本不属于升级来源或目标，拒绝接管');
        const currentManifest = verifyReleaseManifest(path.join(config.deploymentRoot, 'releases', current.releaseId), { allowFixture });
        const currentVersion = { appVersion: currentManifest.appVersion,
          dataSchemaVersion: dbVersion(config.dataRoot) };
        const candidate = await getTeamReleaseCandidateForExecution({
          candidateRoot: path.join(config.dataRoot, 'storage', 'maintenance', 'release-candidates'),
          candidateId: job.target.candidateId, current: currentVersion, allowFixtureForTests: allowFixture,
        });
        const target = candidate.release;
        if (target.releaseId === current.releaseId) throw new Error('目标版本已是当前版本，不重复执行切换');
        const workerDb = openDatabase(config.dataRoot);
        try {
          const principal = job.requestedBy;
          const adapters = {
            async preflight() {
              const from = await currentReleaseIdentity(config);
              if (from.releaseId !== current.releaseId || from.packageSha256 !== current.packageSha256) throw new Error('当前版本已漂移，拒绝开始升级');
              await materializeTeamReleaseCandidate({
                deploymentRoot: config.deploymentRoot, release: candidate.release,
                files: candidate.files, compatibility: candidate.manifest.compatibility,
                manifestContent: candidate.manifestContent,
                allowFixtureForTests: allowFixture,
              });
            },
            async enterMaintenance() { setMaintenance(workerDb, true, `maintenance:${operationId}`); },
            async drainInflight() { return drain(workerDb); },
            async captureExecution() { return captureExecution(config, workerDb, operationId); },
            async stopOldInstance() {
              const state = fs.existsSync(persistedPath) ? readJson(persistedPath) : null;
              const releaseId = state?.completedStages?.includes('switch') ? target.releaseId : current.releaseId;
              try {
                const stopped = await controlled('stop', config, releaseId);
                if (stopped.stopped) return stopped;
                if (stopped.instanceId && Array.isArray(stopped.residualPids)) return stopped;
              } catch (error) {
                if (!state?.completedStages?.includes('stop')) throw error;
              }
              if (state?.completedStages?.includes('stop')) {
                // The previous stop was durable, so a later backup failure must not require the
                // old instance to exist again. Ownership was verified before its first stop.
                return { deploymentId: config.deploymentId, instanceId: 'verified-stopped-instance', stopped: true, residualPids: [] };
              }
              throw new Error('受控停机未确认全部退出，禁止继续切换');
            },
            async createPreUpgradeBackup() {
              const backup = await makeBackup(config, workerDb, principal, 'pre-upgrade', `${operationId}-pre-upgrade`, configPath, true, true);
              const verification = await verifyTeamBackup(backup.directory);
              return { backupId: backup.manifest.backupId, verified: verification.verified };
            },
            async switchRelease() {
              const barrier = acquireLifecycleBarrier(workerDb, principal, 'release', { operationId, releaseId: target.releaseId });
              try {
                await switchTeamReleasePointerIdempotent({ serviceRoot: config.serviceRoot, release: target, expectedReleaseId: current.releaseId });
              } finally { releaseLifecycleBarrier(workerDb, principal, barrier.id); }
            },
            async startMaintenance() {
              const { generateDeploymentConfiguration } = await import('./generate-config.mjs');
              generateDeploymentConfiguration({ ...readJson(configPath), releaseId: target.releaseId }, config.serviceRoot);
              const state = fs.existsSync(persistedPath) ? readJson(persistedPath) : null;
              if (!state?.completedStages?.includes('start_maintenance')) startApp({ ...config, releaseId: target.releaseId });
              await waitService(config, target.releaseId, 'maintenance');
            },
            async migrate() {
              const team = workerDb.prepare('SELECT MAX(version) AS version FROM team_schema_migrations').pluck().get();
              const execution = workerDb.prepare('SELECT MAX(version) AS version FROM execution_schema_migrations').pluck().get();
              if (!team || !execution) throw new Error('追加迁移证据不完整');
              if (team > candidate.manifest.compatibility.dataSchemaMax || team < candidate.manifest.compatibility.dataSchemaMin) {
                throw new Error('迁移后的数据结构超出候选兼容声明，禁止自动回切或恢复生产');
              }
            },
            async selfCheck() {
              const status = await controlled('status', config, target.releaseId);
              const integrity = workerDb.pragma('integrity_check', { simple: true });
              return { available: status.maintenance === true && status.ready === false && integrity === 'ok', automaticRetries: 0 };
            },
            async resume() { await resumeService(config, workerDb, target.releaseId); },
          };
          const state = await runTeamRelease({
            operationId, deploymentId: config.deploymentId, backupRoot: config.backupRoot,
            stateDirectory,
            fromRelease: current, toRelease: target, adapters, onStage,
          });
          return { ...state, actualRelease: target };
        } finally { workerDb.close(); }
      },
      executeCleanup: async (job) => {
        if (job.target.kind !== 'cleanup') throw new Error('维护作业目标不是清理预览');
        const workerDb = openDatabase(config.dataRoot);
        try {
          return executeCleanupPreview({
            db: workerDb, previewId: job.target.previewId, storageRoot: path.join(config.dataRoot, 'storage'),
            backupRoot: config.backupRoot, protectedDataRoots: [config.dataRoot, ...(config.oldRoots ?? [])],
          });
        } finally { workerDb.close(); }
      },
      makeBackup: async ({ job, backupId, onStage }) => {
        const activeConfig = resolveDeploymentConfig(readJson(configPath));
        const workerDb = openDatabase(activeConfig.dataRoot);
        try {
          if (job.target.kind !== 'backup') throw new Error('维护作业目标不是备份');
          const principal = job.requestedBy;
          const backupType = job.target.backupType;
          const result = await makeBackup(activeConfig, workerDb, principal, backupType, backupId, configPath, false, true, onStage);
          const verified = await verifyTeamBackup(result.directory);
          if (!verified.verified || verified.manifest.backupId !== result.manifest.backupId) throw new Error('备份作业结果复核失败');
          onStage('verifying');
          return {
            backupId: result.manifest.backupId, type: result.manifest.type,
            verifiedAt: result.success.verifiedAt, totalBytes: result.success.totalBytes,
          };
        } finally { workerDb.close(); }
      },
      makeRestore: async ({ job, onStage }) => {
        const activeBaseConfig = resolveDeploymentConfig(readJson(configPath));
        const runningRelease = await currentReleaseIdentity(activeBaseConfig);
        const activeConfig = { ...activeBaseConfig, releaseId: runningRelease.releaseId };
        return executeTeamRestoreOperation({
        job, configPath, config: activeConfig, currentRelease: runningRelease, onStage,
        protectConfig: protectConfig(activeConfig),
        beforeMove: args.includes('--test-isolated-cutover') ? undefined : async () => {
          const stopped = await controlled('stop', activeConfig, activeConfig.releaseId);
          if (!stopped.stopped) throw new Error('旧应用未明确停止，拒绝切换活动数据根');
        },
        rollbackService: args.includes('--test-isolated-cutover') ? undefined : async () => {
          const current = readJson(configPathForMaintenance(config));
          generateDeploymentConfiguration(current, activeConfig.serviceRoot);
          startApp(activeConfig);
          await waitService(activeConfig, activeConfig.releaseId, 'maintenance');
        },
        reauthenticatedSession: fs.existsSync(path.join(config.deploymentRoot, 'restore-operations', job.id, 'reauthenticated-session.json'))
          ? readJson(path.join(config.deploymentRoot, 'restore-operations', job.id, 'reauthenticated-session.json')) : undefined,
        diskSpaceProbe: args.includes('--test-disk-space-zero') ? async () => 0 : undefined,
        activate: args.includes('--test-isolated-cutover') ? async (restoredRoot) => {
          const { generateDeploymentConfiguration } = await import('./generate-config.mjs');
          const next = { ...readJson(configPath), dataRoot: restoredRoot };
          generateDeploymentConfiguration(next, config.serviceRoot);
          if (args.includes('--test-cutover-failure')) throw new Error('injected activation failure');
          const temporary = `${configPath}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, configPath);
        } : (restoredRoot) => activateRestoredService(activeConfig, restoredRoot, job.id),
        });
      },
    });
    process.stdout.write(`${JSON.stringify({ status: 'success', worker: true })}\n`);
  } else {
  const db = openDatabase(config.dataRoot);
  try {
    const principal = adminPrincipal(db);
    if (command === 'backup') {
      const type = required('--type');
      const backupId = argument('--backup-id');
      const releaseLock = type === 'daily' ? acquireDailyLock(config) : null;
      if (type === 'daily' && !releaseLock) {
        process.stdout.write(`${JSON.stringify({ status: 'skipped', reason: 'backup_in_progress' })}\n`);
        process.exit(0);
      }
      const startedAt = new Date().toISOString();
      try {
        if (type === 'daily') writeDailyJob(config, { status: 'running', backupId: backupId || null, startedAt });
        try {
          const result = await makeBackup(config, db, principal, type, backupId, configPath);
          if (type === 'daily') {
            const space = fs.statfsSync(config.backupRoot);
            writeDailyJob(config, {
              status: 'success', backupId: result.manifest.backupId, startedAt,
              finishedAt: result.success.verifiedAt, durationMs: result.success.durationMs,
              totalBytes: result.success.totalBytes, availableBytes: space.bavail * space.bsize,
            });
          }
          process.stdout.write(`${JSON.stringify({
            status: 'success', backupId: result.manifest.backupId, backupType: type,
            durationMs: result.success.durationMs, totalBytes: result.success.totalBytes,
            rotation: result.rotation ?? null,
          })}\n`);
        } catch (error) {
          if (type === 'daily') writeDailyJob(config, {
            status: 'failed', backupId: backupId || null, startedAt,
            finishedAt: new Date().toISOString(), code: 'backup_failed',
          });
          throw error;
        }
      } finally {
        releaseLock?.();
      }
    } else if (command === 'restore') {
      const type = required('--backup-type');
      const backupId = required('--backup-id');
      const currentRelease = await currentReleaseIdentity(config);
      const result = await restoreTeamBackup({
        backupDirectory: backupDirectory(config, type, backupId),
        restoreRoot: required('--restore-root'), deploymentId: config.deploymentId,
        expectedReleaseId: currentRelease.releaseId, currentDb: db,
        currentJournalDirectory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
        protectConfig: protectConfig(config),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === 'release' || command === 'rollback') {
      const newReleaseId = required('--new-release-id');
      const operationId = safeId(required('--operation-id'));
      const current = await currentReleaseIdentity(config);
      const target = releaseIdentity(config, newReleaseId, args.includes('--allow-fixture-release'));
      const fromRelease = command === 'release' ? current : current;
      const toRelease = target;
      const reportPath = argument('--compatibility-report');
      if (command === 'release') compatibilityReport(reportPath);
      const releaseAdapters = {
        async preflight() { releaseIdentity(config, toRelease.releaseId, args.includes('--allow-fixture-release')); },
        async enterMaintenance() { setMaintenance(db, true, `maintenance:${operationId}`); },
        async drainInflight() { return drain(db); },
        async captureExecution() { return captureExecution(config, db, operationId); },
        async stopOldInstance() { return controlled('stop', config, fromRelease.releaseId); },
        async createPreUpgradeBackup() {
          const backup = await makeBackup(config, db, principal, 'pre-upgrade', `${operationId}-pre-upgrade`, configPath, true);
          return { backupId: backup.manifest.backupId, verified: true };
        },
        async switchRelease() {
          const barrier = acquireLifecycleBarrier(db, principal, 'release', { operationId, releaseId: toRelease.releaseId });
          try {
            await switchTeamReleasePointerIdempotent({
              serviceRoot: config.serviceRoot, release: toRelease, expectedReleaseId: fromRelease.releaseId,
            });
          } finally {
            releaseLifecycleBarrier(db, principal, barrier.id);
          }
        },
        async startMaintenance() {
          const { generateDeploymentConfiguration } = await import('./generate-config.mjs');
          generateDeploymentConfiguration({ ...readJson(configPath), releaseId: toRelease.releaseId }, config.serviceRoot);
          startApp({ ...config, releaseId: toRelease.releaseId });
          await waitService(config, toRelease.releaseId, 'maintenance');
        },
        async migrate() {
          const team = db.prepare('SELECT MAX(version) AS version FROM team_schema_migrations').pluck().get();
          const execution = db.prepare('SELECT MAX(version) AS version FROM execution_schema_migrations').pluck().get();
          if (!team || !execution) throw new Error('追加迁移证据不完整');
        },
        async selfCheck() {
          const status = await controlled('status', config, toRelease.releaseId);
          const integrity = db.pragma('integrity_check', { simple: true });
          return { available: status.maintenance === true && status.ready === false && integrity === 'ok', automaticRetries: 0 };
        },
        async resume() { await resumeService(config, db, toRelease.releaseId); },
      };
      if (command === 'release') {
        const result = await runTeamRelease({
          operationId, deploymentId: config.deploymentId, backupRoot: config.backupRoot,
          stateDirectory: config.serviceRoot, fromRelease, toRelease, adapters: releaseAdapters,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const strategy = required('--strategy');
        const compatibility = strategy === 'compatible'
          ? compatibilityReport(reportPath)
          : { schemaCompatible: false, irreversibleChanges: true };
        const result = await rollbackTeamRelease({
          operationId, deploymentId: config.deploymentId, backupRoot: config.backupRoot,
          stateDirectory: config.serviceRoot, strategy, compatibility,
          currentRelease: current, targetRelease: target,
          adapters: {
            stopCurrentInstance: releaseAdapters.stopOldInstance,
            switchRelease: releaseAdapters.switchRelease,
            startMaintenance: releaseAdapters.startMaintenance,
            selfCheck: releaseAdapters.selfCheck,
            resume: releaseAdapters.resume,
            async restoreBackup() {
              const restored = await restoreTeamBackup({
                backupDirectory: backupDirectory(config, required('--backup-type'), required('--backup-id')),
                restoreRoot: required('--restore-root'), deploymentId: config.deploymentId,
                expectedReleaseId: target.releaseId, currentDb: db,
                currentJournalDirectory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
                protectConfig: protectConfig(config),
              });
              return { restoreRoot: restored.restoreRoot, scheduling: restored.scheduling, automaticRetries: restored.automaticRetries };
            },
          },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    } else {
      throw new Error('未知维护命令');
    }
  } finally {
    db.close();
  }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '未知错误';
  process.stderr.write(`维护操作失败：${message}\n`);
  process.exitCode = 1;
}
